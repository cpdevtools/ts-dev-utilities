import { discoverProjects } from '../project/discover.js';
import { buildDependencyGraph } from '../project/dependencyGraph.js';
import type { RunOptions, RunSummary, TaskResult, TaskState } from './types.js';
import { execScript } from './exec.js';

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Run one or more scripts across all projects in the workspace, ordered by the
 * dependency graph. Projects start as soon as all their workspace dependencies
 * have passed — not in fixed waves.
 *
 * On failure:
 * - The failed project's transitive dependents are marked `skipped`.
 * - With `failFast: true`, in-flight tasks are cancelled via AbortSignal and all
 *   remaining pending tasks are marked `skipped`.
 */
export async function runScripts(options: RunOptions): Promise<RunSummary> {
  const {
    scripts,
    concurrency = Infinity,
    failFast = false,
    cwd = process.cwd(),
    env = {},
    missingScript = 'skip',
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    beforeTask,
    afterTask,
    _discover = discoverProjects,
    _exec = execScript,
  } = options;

  const allProjects = await _discover({ cwd });

  if (allProjects.length === 0) {
    return { passed: [], failed: [], skipped: [], cancelled: [], noScript: [] };
  }

  const graph = buildDependencyGraph(allProjects);

  // Fail fast if there's a cycle — the ready-set loop would never terminate
  const cycle = graph.detectCycle();
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle.join(' → ')} → ${cycle[0]}`);
  }

  const allNodes = graph.getAllNodes();

  // Per-task state and results
  const states = new Map<string, TaskState>();
  const taskResults = new Map<string, TaskResult>();
  for (const node of allNodes) {
    states.set(node.name, 'pending');
  }

  // Working copies of dependency sets (mutated as tasks complete)
  const pendingDeps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const node of allNodes) {
    pendingDeps.set(node.name, new Set(node.dependencies));
    dependents.set(node.name, new Set(node.dependents));
  }

  const abortCtrl = new AbortController();
  // name → promise that resolves after onTaskComplete has run
  const running = new Map<string, Promise<void>>();

  function makeResult(
    name: string,
    dir: string,
    state: TaskState,
    durationMs: number,
    output?: string,
    truncated?: boolean,
  ): TaskResult {
    return { project: name, projectDir: dir, scripts, state, durationMs, output, truncated };
  }

  async function finalize(name: string, dir: string): Promise<void> {
    if (!afterTask) return;
    const result = taskResults.get(name)!;
    try {
      await afterTask(graph.getNode(name)!.project, result);
    } catch (err) {
      states.set(name, 'failed');
      const hookError = (err as Error).message;
      const combined = result.output ? `${result.output}\n${hookError}` : hookError;
      taskResults.set(name, makeResult(name, dir, 'failed', result.durationMs, combined, result.truncated));
    }
  }

  function getReadyNames(): string[] {
    const ready: string[] = [];
    for (const [name, state] of states) {
      if (state === 'pending' && !running.has(name) && (pendingDeps.get(name)?.size ?? 0) === 0) {
        ready.push(name);
      }
    }
    return ready;
  }

  function markSkipped(name: string): void {
    if (states.get(name) !== 'pending') return;
    const node = graph.getNode(name)!;
    states.set(name, 'skipped');
    taskResults.set(name, makeResult(name, node.project.directory, 'skipped', 0));
    for (const dep of dependents.get(name) ?? []) {
      markSkipped(dep);
    }
  }

  function onTaskComplete(name: string): void {
    running.delete(name);
    const state = states.get(name)!;

    if (state === 'passed' || state === 'no-script') {
      // Unblock dependents — remove this task from their pending deps
      for (const dep of dependents.get(name) ?? []) {
        pendingDeps.get(dep)?.delete(name);
      }
    } else if (state === 'failed') {
      // Skip all transitive dependents
      for (const dep of dependents.get(name) ?? []) {
        markSkipped(dep);
      }
      if (failFast) {
        abortCtrl.abort();
        // Mark all still-pending tasks as skipped
        for (const [n, s] of states) {
          if (s === 'pending') {
            const node = graph.getNode(n)!;
            states.set(n, 'skipped');
            taskResults.set(n, makeResult(n, node.project.directory, 'skipped', 0));
          }
        }
      }
    }
    // 'cancelled': running tasks that were aborted — dependents handled by the fail-fast
    // skipping path above, or will remain in 'skipped' state from markSkipped.
  }

  async function runTask(name: string): Promise<void> {
    const node = graph.getNode(name)!;
    const projectScripts = (node.project.packageJson.scripts ?? {}) as Record<string, string>;
    const scriptsToRun = scripts.filter((s) => s in projectScripts);

    if (scriptsToRun.length === 0) {
      if (missingScript === 'error') {
        states.set(name, 'failed');
        taskResults.set(
          name,
          makeResult(
            name,
            node.project.directory,
            'failed',
            0,
            `None of the target scripts [${scripts.join(', ')}] are defined in "${name}"`,
          ),
        );
      } else {
        states.set(name, 'no-script');
        taskResults.set(name, makeResult(name, node.project.directory, 'no-script', 0));
      }
      return;
    }

    const startTime = Date.now();
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...env,
      PROJECT_NAME: name,
      PROJECT_CWD: node.project.directory,
    };

    // beforeTask hook — runs before any script; failure marks task failed
    if (beforeTask) {
      try {
        await beforeTask(node.project);
      } catch (err) {
        states.set(name, 'failed');
        taskResults.set(
          name,
          makeResult(name, node.project.directory, 'failed', 0, (err as Error).message),
        );
        return; // afterTask is NOT called — scripts never ran
      }
    }

    let combinedOutput = '';
    let anyTruncated = false;

    for (const script of scriptsToRun) {
      if (abortCtrl.signal.aborted) {
        states.set(name, 'cancelled');
        taskResults.set(
          name,
          makeResult(
            name,
            node.project.directory,
            'cancelled',
            Date.now() - startTime,
            combinedOutput || undefined,
            anyTruncated || undefined,
          ),
        );
        await finalize(name, node.project.directory);
        return;
      }

      let result: { exitCode: number; output: string; truncated: boolean };
      try {
        result = await _exec(script, node.project.directory, spawnEnv, abortCtrl.signal, maxOutputBytes);
      } catch (err) {
        const finalState: TaskState = abortCtrl.signal.aborted ? 'cancelled' : 'failed';
        states.set(name, finalState);
        taskResults.set(
          name,
          makeResult(
            name,
            node.project.directory,
            finalState,
            Date.now() - startTime,
            combinedOutput || (err as Error).message || undefined,
          ),
        );
        await finalize(name, node.project.directory);
        return;
      }

      if (result.output) combinedOutput += result.output;
      if (result.truncated) anyTruncated = true;

      if (abortCtrl.signal.aborted) {
        states.set(name, 'cancelled');
        taskResults.set(
          name,
          makeResult(
            name,
            node.project.directory,
            'cancelled',
            Date.now() - startTime,
            combinedOutput || undefined,
            anyTruncated || undefined,
          ),
        );
        await finalize(name, node.project.directory);
        return;
      }

      if (result.exitCode !== 0) {
        states.set(name, 'failed');
        taskResults.set(
          name,
          makeResult(
            name,
            node.project.directory,
            'failed',
            Date.now() - startTime,
            combinedOutput || undefined,
            anyTruncated || undefined,
          ),
        );
        await finalize(name, node.project.directory);
        return;
      }
    }

    states.set(name, 'passed');
    taskResults.set(name, makeResult(name, node.project.directory, 'passed', Date.now() - startTime, combinedOutput || undefined, anyTruncated || undefined));
    await finalize(name, node.project.directory);
  }

  // ----------------------------------------------------------------
  // Main scheduler loop: ready-set event loop
  // ----------------------------------------------------------------
  while (true) {
    if (!abortCtrl.signal.aborted) {
      const ready = getReadyNames();
      for (const name of ready) {
        if (running.size >= concurrency) break;
        // runTask sets its own state; onTaskComplete updates deps/states after completion
        const p = runTask(name).then(() => onTaskComplete(name));
        running.set(name, p);
      }
    }

    if (running.size === 0) break;

    // Wait for ANY running task to complete (onTaskComplete runs before this resumes)
    await Promise.race(running.values());
  }

  // Collect results into summary
  const summary: RunSummary = { passed: [], failed: [], skipped: [], cancelled: [], noScript: [] };
  for (const result of taskResults.values()) {
    switch (result.state) {
      case 'passed':    summary.passed.push(result);   break;
      case 'failed':    summary.failed.push(result);   break;
      case 'skipped':   summary.skipped.push(result);  break;
      case 'cancelled': summary.cancelled.push(result); break;
      case 'no-script': summary.noScript.push(result); break;
    }
  }

  return summary;
}
