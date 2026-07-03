#!/usr/bin/env node
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';
import { discoverProjects, buildDependencyGraph } from '@cpdevtools/ts-dev-utilities/project';
import { checkDepVersions, fixDepVersions } from '@cpdevtools/ts-dev-utilities/dep-versions';
import type { RunSummary } from '@cpdevtools/ts-dev-utilities/runner';
import type { DepChange } from '@cpdevtools/ts-dev-utilities/dep-versions';

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
    console.error('Usage: devutil run <script...> [--output-style silent|summary|full|stream] [--fail-fast] [--concurrency <n>] [--cwd <path>] [--missing-script skip|error] [--max-output <bytes>]');
    process.exit(1);
  }

  const concurrencyRaw = flags['concurrency'];
  const maxOutputRaw = flags['max-output'];
  const outputStyle = parseOutputStyle(flags['output-style']);
  const streamWriter = outputStyle === 'stream' ? createStreamWriter() : undefined;

  const summary = await runScripts({
    scripts: positional,
    failFast: flags['fail-fast'] === true,
    concurrency: concurrencyRaw ? parseInt(concurrencyRaw as string, 10) : undefined,
    cwd: flags['cwd'] as string | undefined,
    missingScript: flags['missing-script'] as 'skip' | 'error' | undefined,
    maxOutputBytes: maxOutputRaw ? parseInt(maxOutputRaw as string, 10) : undefined,
    onOutput: streamWriter ? (project, chunk) => streamWriter.write(project.name, chunk) : undefined,
  });

  streamWriter?.flush();

  if (outputStyle === 'full') {
    printGroupedOutput(summary);
  }

  // 'summary' shows failures only; the other styles have already emitted (or suppress) output.
  printSummary(summary, { showFailureOutput: outputStyle === 'summary' });

  if (summary.failed.length > 0) {
    process.exit(1);
  }
}

type OutputStyle = 'silent' | 'summary' | 'full' | 'stream';

/**
 * Resolves the --output-style flag. When omitted, defaults to 'full' under CI
 * (grouped, non-interleaved logs read better in CI) and 'stream' otherwise.
 */
function parseOutputStyle(value: string | boolean | undefined): OutputStyle {
  if (value === undefined) return isCI() ? 'full' : 'stream';
  const v = String(value).toLowerCase();
  if (v === 'silent' || v === 'summary' || v === 'full' || v === 'stream') return v;
  console.error(`Invalid --output-style value: ${value}. Expected one of: silent, summary, full, stream`);
  process.exit(1);
}

/** Detects a CI environment (GitHub Actions and most other providers set CI). */
function isCI(): boolean {
  if (process.env.GITHUB_ACTIONS === 'true') return true;
  const ci = process.env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

/**
 * Prints each task's full captured output grouped under a per-project header,
 * after all tasks complete. Failures last so they sit closest to the summary.
 */
function printGroupedOutput(summary: RunSummary): void {
  const marks: Record<string, string> = { passed: '✅', cancelled: '🚫', failed: '❌' };

  for (const task of [...summary.passed, ...summary.cancelled, ...summary.failed]) {
    if (!task.output) continue;
    const mark = marks[task.state] ?? '•';
    console.log(`\n${'─'.repeat(60)}\n${mark}  ${task.project}\n${'─'.repeat(60)}`);
    if (task.truncated) {
      console.log(`[Output truncated — showing last ${task.output.length} bytes]\n`);
    }
    console.log(task.output.trimEnd());
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
    process.exit(1);
  }

  const { flags } = parseArgs(rest);
  const cwd = (flags['cwd'] as string | undefined) ?? process.cwd();

  let changes: DepChange[];

  if (subcommand === 'check') {
    changes = await checkDepVersions(file, cwd);
    printDepChanges(changes, false);
    if (changes.length > 0) process.exit(1);
  } else if (subcommand === 'fix') {
    changes = await fixDepVersions(file, cwd);
    printDepChanges(changes, true);
  } else {
    console.error(`Unknown subcommand: ${subcommand}. Use 'check' or 'fix'.`);
    process.exit(1);
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
  console.log(`
devutil — workspace script runner and inspector

Commands:
  run <script...>               Run scripts across all workspace projects, dependency-ordered
  discover                      List all projects in the workspace
  graph                         Print the workspace dependency graph
  dep-versions check <file>     Report version drift against a deps YAML file (exits 1 if drift found)
  dep-versions fix <file>       Apply versions from a deps YAML file to all matching project files

Options (run):
  --output-style <style>   How task output is shown (default: stream, or full under CI):
    silent                   Only the final pass/fail summary counts
    summary                  Captured output for failed tasks only
    full                     Every task's output, grouped by project, at the end
    stream                   Live output as it happens, prefixed with [project]
  --fail-fast              Stop on first failure, cancel in-flight tasks
  --concurrency <n>        Maximum tasks to run in parallel (default: unlimited)
  --cwd <path>             Workspace root (default: current directory)
  --missing-script         What to do when a project lacks the script:
    skip (default)           Treat as a no-op pass
    error                    Treat as a failure
  --max-output <bytes>     Max bytes of output to capture per task (default: 1000000)

Options (discover / graph):
  --cwd <path>             Workspace root (default: current directory)

Examples:
  devutil run github.actions.test
  devutil run build --output-style full
  devutil run github.actions.build github.actions.test --fail-fast
  devutil run github.actions.test --concurrency 4
  devutil discover
  devutil graph
`.trim());
}

// ----------------------------------------------------------------
// Summary output
// ----------------------------------------------------------------

function printSummary(summary: RunSummary, options: { showFailureOutput?: boolean } = {}): void {
  const { showFailureOutput = true } = options;

  if (showFailureOutput) {
    for (const task of summary.failed) {
      const header = `\n${'─'.repeat(60)}\n❌  FAILED: ${task.project}\n${'─'.repeat(60)}`;
      console.error(header);
      if (task.output) {
        if (task.truncated) {
          console.error(`[Output truncated — showing last ${task.output.length} bytes]\n`);
        }
        console.error(task.output.trimEnd());
      }
    }
  }

  console.log('\n' + [
    `✅  Passed:    ${summary.passed.length}`,
    `❌  Failed:    ${summary.failed.length}`,
    `⏭   Skipped:   ${summary.skipped.length}`,
    `🚫  Cancelled: ${summary.cancelled.length}`,
    ...(summary.noScript.length > 0 ? [`—   No script: ${summary.noScript.length}`] : []),
  ].join('\n'));
}

// ----------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------

const [, , command, ...rest] = process.argv;

(async () => {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'run':          await cmdRun(rest);         break;
    case 'discover':     await cmdDiscover(rest);    break;
    case 'graph':        await cmdGraph(rest);       break;
    case 'dep-versions': await cmdDepVersions(rest); break;
    default:
      console.error(`Unknown command: ${command}\nRun 'devutil help' for usage.`);
      process.exit(1);
  }
})().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
