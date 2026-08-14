# Parallel Script Runner

`runScripts()` runs one or more npm scripts across every project in a workspace, ordered by the
dependency graph and as parallel as that graph allows.

```ts
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';

const summary = await runScripts({
  scripts: ['github.actions.build', 'github.actions.test'],
  cwd: process.cwd(),
});
```

The same engine backs [`devutil run`](devutil-CLI) and git-flow's `test` action.

## The scheduling model

A project starts the moment **all of its workspace dependencies have passed** — not when its
topological tier completes. There are no waves and no barriers.

```
discover projects (pnpm workspace members)
build dependency graph (workspace deps only)
abort immediately if the graph has a cycle

loop:
  while running < concurrency and some task is ready:
      launch it
  await the first task to settle
    passed / no-script → remove it from its dependents' pending sets
    failed             → mark ALL transitive dependents skipped
                         if failFast: abort in-flight tasks, skip everything pending
until nothing is running and nothing is ready
```

Wall-clock is therefore bounded by the longest dependency _chain_, not by the sum of the slowest
project per tier.

Scripts within a single project run **sequentially** in the order given. `['build', 'test']` means
build-then-test per project; a non-zero exit from the first stops that project and its remaining
scripts are not run.

## Task states

Every project ends in exactly one state, and the [`RunSummary`](#runsummary) buckets them.

| State       | Meaning                                                                    | Unblocks dependents?        |
| ----------- | -------------------------------------------------------------------------- | --------------------------- |
| `passed`    | Every matching script exited 0.                                            | ✅                          |
| `no-script` | The project defines _none_ of the target scripts. Treated as a no-op pass. | ✅                          |
| `failed`    | A script exited non-zero, or a hook threw.                                 | ❌ dependents are `skipped` |
| `skipped`   | A dependency failed, or fail-fast cancelled the run before this started.   | —                           |
| `cancelled` | Was mid-run when fail-fast aborted.                                        | —                           |

`pending` and `running` are internal states; they never appear in a result.

## Options

```ts
interface RunOptions {
  scripts: string[];
  concurrency?: number;
  failFast?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  missingScript?: 'skip' | 'error';
  maxOutputBytes?: number;
  onOutput?: (project: Project, chunk: string) => void;
  beforeTask?: (
    project: Project,
  ) => Promise<void | Record<string, string>> | void | Record<string, string>;
  afterTask?: (project: Project, result: TaskResult) => Promise<void> | void;
}
```

| Option                     | Default         | Notes                                                                                     |
| -------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `scripts`                  | _(required)_    | Script names to look for in each project's `package.json`.                                |
| `concurrency`              | `Infinity`      | Maximum tasks in flight.                                                                  |
| `failFast`                 | `false`         | Keep-going is the default, so one failure still yields full coverage elsewhere.           |
| `cwd`                      | `process.cwd()` | Workspace root to discover from.                                                          |
| `env`                      | `{}`            | Extra env for every spawned process. Cannot vary per project — use `beforeTask` for that. |
| `missingScript`            | `'skip'`        | `'skip'` → `no-script` (a pass). `'error'` → `failed`, which skips dependents.            |
| `maxOutputBytes`           | `1_000_000`     | Per-task capture cap. Only affects what is _buffered_, not `onOutput`.                    |
| `onOutput`                 | —               | Live stream of combined stdout+stderr, unbounded.                                         |
| `beforeTask` / `afterTask` | —               | See [Hooks](#hooks).                                                                      |

> `RunOptions` also declares `_discover` and `_exec`. These are unit-test injection points, not
> public API — do not build on them.

## Results

### TaskResult

```ts
interface TaskResult {
  project: string; // package.json name
  projectDir: string; // absolute path
  scripts: string[]; // the scripts that were targeted (not necessarily run)
  state: TaskState;
  durationMs: number;
  output?: string; // combined stdout+stderr, capped at maxOutputBytes
  truncated?: boolean; // true when the cap was hit
}
```

`output` is present for tasks that actually executed — `passed`, `failed`, `cancelled`. `skipped`
and `no-script` results have `durationMs: 0` and no output.

### RunSummary

```ts
interface RunSummary {
  passed: TaskResult[];
  failed: TaskResult[];
  skipped: TaskResult[];
  cancelled: TaskResult[];
  noScript: TaskResult[];
}
```

`runScripts` does not throw on task failure and does not set an exit code — inspect
`summary.failed` and decide. It _does_ throw for a workspace-level problem: a dependency cycle
raises `Circular dependency detected: a → b → a` before anything runs.

An empty workspace returns an all-empty summary rather than an error.

## Environment given to each script

Scripts are executed as `pnpm run <script>` in the project directory, with:

| Variable       | Value                                           |
| -------------- | ----------------------------------------------- |
| _(inherited)_  | The parent `process.env`                        |
| `env`          | Whatever you passed in `RunOptions.env`         |
| `PROJECT_NAME` | The project's `package.json` name               |
| `PROJECT_CWD`  | The project's absolute directory                |
| _(hook)_       | Anything returned by `beforeTask`, applied last |

Precedence runs left to right, so `beforeTask` wins over `env`, which wins over the inherited
environment.

## Hooks

Hooks make the runner useful as a build/pack engine rather than just a test runner — git-flow uses
`beforeTask` to inject per-project version and output-path variables.

### `beforeTask(project)`

Called after a project becomes ready and **before** any of its scripts run. Returning a
`Record<string, string>` merges those variables into that project's environment — this is the only
way to pass per-project values, since `env` is workspace-wide.

If it throws, the project is marked `failed`, its scripts never run, its dependents are `skipped`,
and **`afterTask` is not called**.

```ts
await runScripts({
  scripts: ['github.actions.pack'],
  beforeTask: (project) => ({
    ARTIFACT_OUTPUT_DIR: join(outDir, project.name.replace('/', '-')),
    PROJECT_VERSION: versions[project.name],
  }),
});
```

### `afterTask(project, result)`

Called once the project's scripts have finished and its result is recorded — for `passed`,
`failed` and `cancelled`. It is **not** called for `no-script` tasks, nor for tasks skipped or
cancelled before they started.

If it throws, the result is overridden to `failed` (the hook's message is appended to the captured
output) and dependents are skipped. That makes it a natural place for post-conditions:

```ts
afterTask: async (project, result) => {
  if (result.state === 'passed' && !(await exists(join(project.directory, 'dist')))) {
    throw new Error('build passed but produced no dist/');
  }
},
```

## Output handling

Two independent mechanisms:

- **Capture** — combined stdout+stderr buffered per task up to `maxOutputBytes` (1 MB default).
  When the cap is hit, capture stops and `truncated: true` is set on the result.
- **Streaming** — if `onOutput` is set, every chunk is forwarded as it arrives, with no cap. The
  CLI's `--output-style stream` uses this with a line-buffered, `[project]`-prefixed writer so
  interleaved parallel output stays readable.

## Failure behaviour

**Keep-going (default).** A failure marks the project `failed` and all of its transitive dependents
`skipped`. Unrelated branches of the graph keep running to completion, so one run surfaces as many
independent failures as possible.

**Fail-fast (`failFast: true`).** In addition, a shared `AbortController` is aborted: in-flight
tasks are killed and become `cancelled`, and everything not yet started becomes `skipped`.

## Worked example

```ts
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';

const summary = await runScripts({
  scripts: ['github.actions.build', 'github.actions.test'],
  concurrency: 4,
  missingScript: 'skip',
  onOutput: (project, chunk) => process.stdout.write(`[${project.name}] ${chunk}`),
  afterTask: (project, result) => {
    console.log(`${result.state.padEnd(9)} ${project.name} (${result.durationMs}ms)`);
  },
});

for (const task of summary.failed) {
  console.error(`\n── ${task.project} ──\n${task.output ?? '(no output)'}`);
}

process.exit(summary.failed.length > 0 ? 1 : 0);
```

## See also

- [devutil CLI](devutil-CLI) — the same engine from the command line.
- [Project Discovery](Project-Discovery) — how the graph the scheduler walks is built.
- [Gotchas](Gotchas) — `no-script` going green is the one that catches people.

Source:
[`src/runner/scheduler.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/runner/scheduler.ts) ·
[`src/runner/exec.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/runner/exec.ts)
