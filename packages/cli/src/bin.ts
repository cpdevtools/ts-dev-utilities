#!/usr/bin/env node
import { writeSync } from 'node:fs';
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';
import { discoverProjects, buildDependencyGraph } from '@cpdevtools/ts-dev-utilities/project';
import { checkDepVersions, fixDepVersions } from '@cpdevtools/ts-dev-utilities/dep-versions';
import {
  autoLink,
  getDevLinkStatus,
  linkPackages,
  loadDevLinkConfig,
  unlinkPackages,
} from '@cpdevtools/ts-dev-utilities/dev-link';
import type { RunSummary, TaskResult } from '@cpdevtools/ts-dev-utilities/runner';
import type { DepChange } from '@cpdevtools/ts-dev-utilities/dep-versions';
import type { DevLinkStatusEntry } from '@cpdevtools/ts-dev-utilities/dev-link';

// ----------------------------------------------------------------
// Argument parser
// ----------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

// ----------------------------------------------------------------
// Commands
// ----------------------------------------------------------------

async function cmdRun(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);

  if (positional.length === 0) {
    console.error(
      'Usage: devutil run <script...> [--output-style stream|task|summary|silent] [--fail-fast] [--concurrency <n>] [--cwd <path>] [--missing-script skip|error] [--max-output <bytes>]',
    );
    process.exitCode = 1;
    return;
  }

  const concurrencyRaw = flags['concurrency'];
  const concurrency = concurrencyRaw ? parseInt(concurrencyRaw as string, 10) : undefined;
  const maxOutputRaw = flags['max-output'];
  const outputStyle = parseOutputStyle(flags['output-style']);
  const streamWriter = outputStyle === 'stream' ? createStreamWriter() : undefined;
  // 'task' with --concurrency 1: only one task can be emitting, so block
  // integrity is guaranteed without buffering — relay output VERBATIM as it is
  // produced. A task whose own tooling (a nested devutil, wireit) emits
  // per-unit blocks as inner units finish then shows those blocks at their
  // real completion times instead of holding them until the outer task ends.
  const relay = outputStyle === 'task' && concurrency === 1;
  // 'task' prints each task's block the moment it finishes. afterTask is not
  // called for tasks that never ran a script (missing-script=error), so track
  // what was printed and catch up on unprinted failures after the run.
  const printedTasks = new Set<string>();
  // A task's output is only printed once it finishes, so a run that is killed
  // mid-flight (terminated CI runner, timeout) would otherwise report nothing
  // at all for whatever was still running. Accumulate output as it arrives and
  // flush the unprinted remainder from a signal handler. Relay mode needs
  // neither: everything is already on screen.
  const maxOutputBytes = maxOutputRaw ? parseInt(maxOutputRaw as string, 10) : DEFAULT_MAX_OUTPUT;
  const showsOutput = (outputStyle === 'task' && !relay) || outputStyle === 'summary';
  const inFlight = showsOutput ? createOutputAccumulator(maxOutputBytes) : undefined;
  if (inFlight) installAbortFlush(inFlight, printedTasks);

  const summary = await runScripts({
    scripts: positional,
    failFast: flags['fail-fast'] === true,
    concurrency,
    cwd: flags['cwd'] as string | undefined,
    missingScript: flags['missing-script'] as 'skip' | 'error' | undefined,
    maxOutputBytes: maxOutputRaw ? parseInt(maxOutputRaw as string, 10) : undefined,
    onOutput:
      streamWriter || inFlight || relay
        ? (project, chunk) => {
            if (relay) {
              process.stdout.write(chunk);
              return;
            }
            streamWriter?.write(project.name, chunk);
            inFlight?.write(project.name, chunk);
          }
        : undefined,
    beforeTask: relay ? (project) => printTaskStart(project.name) : undefined,
    afterTask:
      outputStyle === 'task'
        ? (_project, result) => {
            if (relay) {
              printTaskEnd(result);
              // Failed tasks are re-dumped whole after the run; everything
              // else has already been shown in full.
              if (result.state !== 'failed') printedTasks.add(result.project);
              return;
            }
            if (printTaskBlock(result)) printedTasks.add(result.project);
            inFlight?.discard(result.project);
          }
        : undefined,
  });

  streamWriter?.flush();

  if (outputStyle === 'task') {
    for (const task of summary.failed) {
      if (!printedTasks.has(task.project)) printTaskBlock(task);
    }
  } else if (outputStyle === 'summary') {
    printGroupedOutput(summary);
  }

  printSummary(summary);

  if (summary.failed.length > 0) {
    // Not process.exit(): when stdout is a pipe, console.log is async and
    // exit() drops the buffered tail — including the summary we just printed.
    process.exitCode = 1;
  }
}

type OutputStyle = 'stream' | 'task' | 'summary' | 'silent';

/**
 * Resolves the --output-style flag. When omitted, defaults to 'task' under CI
 * (grouped, non-interleaved blocks that still show progress as tasks finish)
 * and 'stream' otherwise.
 */
function parseOutputStyle(value: string | boolean | undefined): OutputStyle {
  if (value === undefined) return isCI() ? 'task' : 'stream';
  const v = String(value).toLowerCase();
  if (v === 'stream' || v === 'task' || v === 'summary' || v === 'silent') return v;
  // Thrown (not process.exit) so the top-level catch reports it and stdio drains.
  throw new Error(
    `Invalid --output-style value: ${value}. Expected one of: stream, task, summary, silent`,
  );
}

/** Detects a CI environment (GitHub Actions and most other providers set CI). */
function isCI(): boolean {
  if (process.env.GITHUB_ACTIONS === 'true') return true;
  const ci = process.env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

const TASK_MARKS: Record<string, string> = { passed: '✅', cancelled: '🚫', failed: '❌' };

/** Relay mode: header printed when a task starts (its output follows live). */
function printTaskStart(project: string): void {
  console.log(`\n${'─'.repeat(60)}\n▶  ${project}\n${'─'.repeat(60)}`);
}

/** Relay mode: completion marker printed when a task finishes. */
function printTaskEnd(task: TaskResult): void {
  const mark = TASK_MARKS[task.state] ?? '•';
  console.log(`${mark}  ${task.project} (${(task.durationMs / 1000).toFixed(1)}s)`);
}

/**
 * Prints one task's full captured output under a per-project header. Returns
 * false when there was nothing to show (no output, and not a failure — a
 * failure must always surface, even when it died before producing output:
 * spawn failure, missing node_modules, OOM kill).
 */
function printTaskBlock(task: TaskResult): boolean {
  if (!task.output && task.state !== 'failed') return false;
  const mark = TASK_MARKS[task.state] ?? '•';
  console.log(`\n${'─'.repeat(60)}\n${mark}  ${task.project}\n${'─'.repeat(60)}`);
  if (task.truncated && task.output) {
    console.log(`[Output truncated — showing last ${task.output.length} bytes]\n`);
  }
  console.log(task.output ? task.output.trimEnd() : '(no output captured)');
  return true;
}

/**
 * Prints every task's output grouped under a per-project header, after all
 * tasks complete. Failures last so they sit closest to the summary.
 */
function printGroupedOutput(summary: RunSummary): void {
  for (const task of [...summary.passed, ...summary.cancelled, ...summary.failed]) {
    printTaskBlock(task);
  }
}

/**
 * Builds a line-buffered writer that prefixes each output line with its project
 * name, so interleaved output from parallel tasks stays readable.
 */
function createStreamWriter(): {
  write: (project: string, chunk: string) => void;
  flush: () => void;
} {
  const partial = new Map<string, string>();

  return {
    write(project, chunk) {
      const text = (partial.get(project) ?? '') + chunk;
      const lines = text.split('\n');
      partial.set(project, lines.pop() ?? '');
      for (const line of lines) {
        process.stdout.write(`[${project}] ${line}\n`);
      }
    },
    flush() {
      for (const [project, rest] of partial) {
        if (rest) process.stdout.write(`[${project}] ${rest}\n`);
      }
      partial.clear();
    },
  };
}

/** Mirrors the runner's own default capture limit (see RunOptions.maxOutputBytes). */
const DEFAULT_MAX_OUTPUT = 1_000_000;

/**
 * Accumulates each project's output as it arrives, keeping at most the last
 * maxBytes per project — the same tail-retention the runner applies to its own
 * capture, so a flushed buffer matches what the finished task would have shown.
 */
function createOutputAccumulator(maxBytes: number): {
  write: (project: string, chunk: string) => void;
  discard: (project: string) => void;
  entries: () => IterableIterator<[string, string]>;
} {
  const buffers = new Map<string, string>();

  return {
    write(project, chunk) {
      const next = (buffers.get(project) ?? '') + chunk;
      buffers.set(project, next.length > maxBytes ? next.slice(next.length - maxBytes) : next);
    },
    discard(project) {
      buffers.delete(project);
    },
    entries() {
      return buffers.entries();
    },
  };
}

/**
 * Prints the output of every task still in flight when the process is signalled,
 * so a killed run is diagnosable from its first occurrence.
 *
 * Writes with writeSync rather than console.log: stdout to a pipe is async, and
 * the exit that follows a signal drops anything still buffered — which is the
 * failure this exists to prevent.
 */
function installAbortFlush(
  accumulator: { entries: () => IterableIterator<[string, string]> },
  printed: Set<string>,
): void {
  let flushed = false;

  const flush = (signal: NodeJS.Signals, code: number): void => {
    if (flushed) return;
    flushed = true;

    for (const [project, output] of accumulator.entries()) {
      if (printed.has(project) || !output) continue;
      const rule = '\u2500'.repeat(60);
      writeSync(
        1,
        `\n${rule}\n\u26A0\uFE0F  ${project} (interrupted by ${signal} — partial output)\n${rule}\n${output.trimEnd()}\n`,
      );
    }

    process.exit(code);
  };

  process.once('SIGINT', () => flush('SIGINT', 130));
  process.once('SIGTERM', () => flush('SIGTERM', 143));
}

async function cmdDiscover(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const cwd = (flags['cwd'] as string | undefined) ?? process.cwd();

  const projects = await discoverProjects({ cwd });

  if (projects.length === 0) {
    console.log('No projects found.');
    return;
  }

  for (const p of projects) {
    const scriptNames = Object.keys(p.packageJson.scripts ?? {});
    console.log(`${p.name}`);
    console.log(`  dir:     ${p.directory}`);
    console.log(`  scripts: ${scriptNames.length > 0 ? scriptNames.join(', ') : '(none)'}`);
  }

  console.log(`\n${projects.length} project(s) found`);
}

async function cmdDepVersions(args: string[]): Promise<void> {
  const [subcommand, file, ...rest] = args;

  if (!subcommand || !file) {
    console.error('Usage: devutil dep-versions <check|fix> <file> [--cwd <path>]');
    process.exitCode = 1;
    return;
  }

  const { flags } = parseArgs(rest);
  const cwd = (flags['cwd'] as string | undefined) ?? process.cwd();

  let changes: DepChange[];

  if (subcommand === 'check') {
    changes = await checkDepVersions(file, cwd);
    printDepChanges(changes, false);
    if (changes.length > 0) process.exitCode = 1;
  } else if (subcommand === 'fix') {
    changes = await fixDepVersions(file, cwd);
    printDepChanges(changes, true);
  } else {
    console.error(`Unknown subcommand: ${subcommand}. Use 'check' or 'fix'.`);
    process.exitCode = 1;
  }
}

function printDepChanges(changes: DepChange[], fixed: boolean): void {
  if (changes.length === 0) {
    console.log('✅ All dep versions are up to date');
    return;
  }

  const byFile = new Map<string, DepChange[]>();
  for (const c of changes) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }

  for (const [file, fileChanges] of byFile) {
    console.log(`  ${file}`);
    for (const c of fileChanges) {
      console.log(`    ${c.name}: ${c.from} → ${c.to}`);
    }
  }

  const verb = fixed ? 'updated' : 'out of date';
  const hint = fixed ? '' : "\n  Run 'devutil dep-versions fix <file>' to apply";
  console.log(`\n${changes.length} version(s) ${verb}${hint}`);
}

async function cmdDevLink(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand || !['status', 'link', 'unlink', 'auto'].includes(subcommand)) {
    console.error(
      'Usage: devutil dev-link <status|link|unlink|auto> [pkg...] [--config <path>] [--cwd <path>] [--check]',
    );
    process.exitCode = 1;
    return;
  }

  const { positional, flags } = parseArgs(rest);
  const cwd = (flags['cwd'] as string | undefined) ?? process.cwd();
  const configPath = flags['config'] as string | undefined;
  const packages = positional.length > 0 ? positional : undefined;

  // auto is the postinstall entry point — it must never fail an install.
  if (subcommand === 'auto') {
    try {
      const { ran, results } = await autoLink({ cwd, configPath, packages });
      if (ran) for (const r of results) console.log(`dev-link: ${r.message}`);
    } catch (err) {
      console.warn(`dev-link auto: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const config = await loadDevLinkConfig(cwd, configPath);
  if (!config) {
    console.log('dev-link: nothing configured (no .publish/dev-local.yml package map)');
    return;
  }

  if (subcommand === 'link') {
    const results = await linkPackages(config, { cwd, packages });
    for (const r of results) console.log(r.message);
    if (results.some((r) => r.action === 'refused')) process.exitCode = 1;
  } else if (subcommand === 'unlink') {
    const results = await unlinkPackages(config, { cwd, packages });
    for (const r of results) console.log(r.message);
    if (results.some((r) => r.action === 'removed')) process.exitCode = 1;
  } else {
    const report = await getDevLinkStatus(config, { cwd, packages });
    const name = (e: DevLinkStatusEntry): string => (e.location ? `${e.pkg} (${e.location})` : e.pkg);
    const width = Math.max(...report.entries.map((e) => name(e).length));
    for (const e of report.entries) {
      console.log(`${name(e).padEnd(width)}  ${formatDevLinkStatus(e)}`);
    }
    if (report.resetByInstall.length > 0) {
      console.log(
        `\nA pnpm install has reset these links — rerun 'devutil dev-link link':\n  ${report.resetByInstall.join('\n  ')}`,
      );
    }
    if (flags['check'] === true) {
      const unlinked = report.entries.filter((e) => e.install === 'published' || e.install === 'not-symlink');
      if (unlinked.length > 0 || report.resetByInstall.length > 0) process.exitCode = 1;
    }
  }
}

function formatDevLinkStatus(e: DevLinkStatusEntry): string {
  if (e.install === 'linked') return `LINKED → ${e.localPath} (${e.localVersion ?? '?'})`;
  if (e.install === 'not-installed') return 'not installed';
  if (e.install === 'not-symlink') return `real directory (${e.installedVersion ?? '?'}) — dev-link will not touch it`;
  const published = `published (${e.installedVersion ?? '?'})`;
  if (e.checkout === 'missing') return `${published} — checkout missing at ${e.localPath}`;
  if (e.checkout === 'not-built') return `${published} — checkout not built (run pnpm build in ${e.localPath})`;
  return published;
}

async function cmdGraph(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const cwd = (flags['cwd'] as string | undefined) ?? process.cwd();

  const projects = await discoverProjects({ cwd });

  if (projects.length === 0) {
    console.log('No projects found.');
    return;
  }

  const graph = buildDependencyGraph(projects);

  for (const node of graph.getAllNodes()) {
    const deps = [...node.dependencies];
    if (deps.length > 0) {
      console.log(`${node.name}`);
      for (const dep of deps) {
        console.log(`  └─ ${dep}`);
      }
    } else {
      console.log(`${node.name}  (no workspace deps)`);
    }
  }
}

function printHelp(): void {
  console.log(
    `
devutil — workspace script runner and inspector

Commands:
  run <script...>               Run scripts across all workspace projects, dependency-ordered
  discover                      List all projects in the workspace
  graph                         Print the workspace dependency graph
  dep-versions check <file>     Report version drift against a deps YAML file (exits 1 if drift found)
  dep-versions fix <file>       Apply versions from a deps YAML file to all matching project files
  dev-link status [pkg...]      Show which mapped packages are linked to local checkouts (--check exits 1 unless all linked)
  dev-link link [pkg...]        Repoint installed packages at local checkouts from .publish/dev-local.yml (refuses under CI)
  dev-link unlink [pkg...]      Restore the original pnpm-installed symlinks
  dev-link auto                 postinstall hook: link everything mapped, only when DEV_LOCAL=true and not CI; always exits 0

Options (run):
  --output-style <style>   How task output is shown (default: stream, or task under CI):
    stream                   Live output as it happens, prefixed with [project]
    task                     Each task's output, grouped by project, as soon as that task finishes.
                             With --concurrency 1, output is relayed verbatim as it is produced, so
                             per-unit blocks from a task's own tooling land at their real times
    summary                  Nothing during the run; every task's output at the end, failures last
    silent                   Only the final counts (plus failed project names)
  --fail-fast              Stop on first failure, cancel in-flight tasks
  --concurrency <n>        Maximum tasks to run in parallel (default: unlimited)
  --cwd <path>             Workspace root (default: current directory)
  --missing-script         What to do when a project lacks the script:
    skip (default)           Treat as a no-op pass
    error                    Treat as a failure
  --max-output <bytes>     Max bytes of output to capture per task (default: 1000000)

Options (discover / graph):
  --cwd <path>             Workspace root (default: current directory)

Options (dev-link):
  --config <path>          Package map location (default: .publish/dev-local.yml)
  --cwd <path>             Workspace root (default: current directory)
  --check                  status only: exit 1 unless every installed mapped package is linked

Examples:
  devutil run github.actions.test
  devutil run build --output-style task
  devutil run github.actions.build github.actions.test --fail-fast
  devutil run github.actions.test --concurrency 4
  devutil discover
  devutil graph
`.trim(),
  );
}

// ----------------------------------------------------------------
// Summary output
// ----------------------------------------------------------------

function printSummary(summary: RunSummary): void {
  const lines = [
    `✅  Passed:    ${summary.passed.length}`,
    `❌  Failed:    ${summary.failed.length}`,
    `⏭   Skipped:   ${summary.skipped.length}`,
    `🚫  Cancelled: ${summary.cancelled.length}`,
    ...(summary.noScript.length > 0 ? [`—   No script: ${summary.noScript.length}`] : []),
  ];
  // Failures are always named here, in every output style — a failed project
  // must be identifiable even when its captured output is empty.
  if (summary.failed.length > 0) {
    lines.push('', 'Failed projects:', ...summary.failed.map((t) => `  ❌  ${t.project}`));
  }
  console.log('\n' + lines.join('\n'));
}

// ----------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------

// When output is piped to a consumer that exits early (e.g. `devutil run … | head`),
// further writes raise EPIPE. Exit quietly like other Unix tools instead of
// crashing with an unhandled 'error' event.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

const [, , command, ...rest] = process.argv;

(async () => {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'run':
      await cmdRun(rest);
      break;
    case 'discover':
      await cmdDiscover(rest);
      break;
    case 'graph':
      await cmdGraph(rest);
      break;
    case 'dep-versions':
      await cmdDepVersions(rest);
      break;
    case 'dev-link':
      await cmdDevLink(rest);
      break;
    default:
      console.error(`Unknown command: ${command}\nRun 'devutil help' for usage.`);
      process.exitCode = 1;
  }
})().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
