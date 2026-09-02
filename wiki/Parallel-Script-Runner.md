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

A project starts as soon as **all of its own workspace dependencies have passed**. It does not wait
for unrelated projects to finish first, so a slow project only delays the projects that depend on
it.

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

Total run time is therefore determined by the longest chain of dependencies, not by the total number
of projects.

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
| `failFast`                 | `false`         | By default the run continues after a failure, so unrelated projects still complete.       |
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

Hooks allow the runner to be used for build and pack work as well as testing. git-flow uses
`beforeTask` to supply per-project version and output-path variables.

### `beforeTask(project)`

Called after a project becomes ready and **before** any of its scripts run. Returning a
`Record<string, string>` merges those variables into that project's environment — this is the only
way to pass per-project values, since `env` is workspace-wide.

It also runs for a project that defines **none** of the target scripts (`no-script`). Nothing is
spawned for those, so the returned env is ignored — the hook's side effects are the point.

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
`failed`, `cancelled` and `no-script`. It is **not** called for tasks skipped or cancelled before
they started, nor when `beforeTask` threw.

A `no-script` task is still a node in the graph: it unblocks its dependents and counts as a pass, so
the hooks run for it too — per-project work wrapped around the script (version stamping, packing,
publishing) has to happen for every project that was scheduled, in dependency order, not only for
the ones that happen to define the script. Branch on `result.state === 'no-script'` when the hook
should only act on work that actually ran.

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

**By default the run continues.** A failure marks that project `failed` and all of its dependents,
direct and indirect, `skipped`. Projects that do not depend on it continue to completion, so a
single run reports as many independent failures as possible.

**With `failFast: true` the run stops.** In addition to the above, a shared `AbortController` is
aborted: tasks already running are terminated and marked `cancelled`, and any task that has not
started is marked `skipped`.

## Example

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
