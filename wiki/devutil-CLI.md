# devutil CLI

`devutil` is the binary shipped by `@cpdevtools/ts-dev-utilities-cli`. Every command is a thin
wrapper over an exported library function, so anything the CLI does is also available from code.

```bash
devutil help          # or --help / -h / no arguments
```

## Commands

| Command                             | Purpose                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `devutil run <script...>`           | Run scripts across all workspace projects, dependency-ordered.        |
| `devutil discover`                  | List every discovered project with its directory and defined scripts. |
| `devutil graph`                     | Print each project's workspace dependencies.                          |
| `devutil dep-versions check <file>` | Report version drift against a deps YAML file.                        |
| `devutil dep-versions fix <file>`   | Apply the versions from that file.                                    |
| `devutil dev-link status [pkg...]`  | Show which mapped packages are linked to local checkouts.             |
| `devutil dev-link link [pkg...]`    | Repoint installed packages at local checkouts.                        |
| `devutil dev-link unlink [pkg...]`  | Restore the original pnpm-installed symlinks.                         |
| `devutil dev-link auto`             | postinstall hook — link when `DEV_LOCAL=true`, never fail.            |

All commands accept `--cwd <path>` to point at a workspace root other than the current directory.

## Flags

Every flag is either a **value flag** or a **boolean flag**, and the parser is strict about both:

| Kind    | Flags                                                                                      | Rule                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Value   | `--output-style`, `--concurrency`, `--cwd`, `--missing-script`, `--max-output`, `--config` | Must be followed by a value. Reaching the end of the arguments, or a next token starting with `--`, is an error. |
| Boolean | `--fail-fast`, `--check`                                                                   | Take no value.                                                                                                   |

Flags are declared per command: `run` accepts the `run` options below, `dev-link` accepts
`--config`, `--cwd` and `--check`, and `discover`, `graph` and `dep-versions` accept only `--cwd`.
An unknown `--flag` — including one that belongs to a different command — is an error naming the
flag. `--concurrency` and `--max-output` must be integers ≥ 1 — `0`, negatives, decimals and
non-numbers are all rejected. Every one of these errors prints its message to stderr and exits 1
before anything runs.

---

## `devutil run`

```bash
devutil run <script...> [options]
```

Positional arguments are script names. Multiple scripts run **sequentially within each project**,
in the order given, while projects themselves run in parallel subject to the dependency graph.

```bash
devutil run github.actions.test
devutil run github.actions.build github.actions.test
devutil run build --output-style task
devutil run github.actions.test --fail-fast --concurrency 4
```

### Options

| Flag                             | Default                      | Description                                                                   |
| -------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `--output-style <style>`         | `stream`, or `task` under CI | How task output is shown — see below.                                         |
| `--fail-fast`                    | off                          | Stop on first failure, cancelling in-flight tasks.                            |
| `--concurrency <n>`              | unlimited                    | Maximum projects running at once. Integer ≥ 1.                                |
| `--cwd <path>`                   | current directory            | Workspace root.                                                               |
| `--missing-script <skip\|error>` | `skip`                       | `skip` treats a project without the script as a no-op pass; `error` fails it. |
| `--max-output <bytes>`           | `1000000`                    | Per-task capture cap. Integer ≥ 1. Does not limit `stream`.                   |

### Output styles

| Style     | Behaviour                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stream`  | Live output as it happens, every line prefixed with `[project]`. Default outside CI.                                                                                                                                                                                                                                                                                                             |
| `task`    | Each task's output, grouped under a per-project header, printed as soon as that task finishes. Blocks appear in completion order and never interleave. With `--concurrency 1`, output is relayed verbatim as it is produced — blocks emitted by a task's own tooling (a nested `devutil run`, wireit) land at their real completion times instead of when the outer task ends. Default under CI. |
| `summary` | Nothing during the run; afterwards every task's output, grouped under a per-project header, failures last, so they appear directly above the summary.                                                                                                                                                                                                                                            |
| `silent`  | Only the final pass/fail counts (failed projects are still named).                                                                                                                                                                                                                                                                                                                               |

CI is detected as `GITHUB_ACTIONS=true`, or `CI` set to anything other than empty, `false` or `0`.
Grouped (`task`) output is the CI default because interleaved parallel logs are hard to read in a
GitHub Actions log view, and per-task blocks still show progress while the run is live.

### Summary and exit code

Every run ends with counts:

```
✅  Passed:    7
❌  Failed:    1
⏭   Skipped:   2
🚫  Cancelled: 0
—   No script: 3
```

The `No script:` line only appears when there were such tasks, and a `Failed projects:` list
follows the counts whenever there is a failure — in every output style, including `silent`, so a
failed project is identifiable even when its captured output is empty. **Exit code is `1` if any
task failed, otherwise `0`** — skipped and cancelled tasks do not by themselves fail the run, but
they only occur as a consequence of a failure. The code is set via `process.exitCode` rather than
`process.exit()`, so a piped summary is never truncated.

If the process is signalled (`SIGINT`, `SIGTERM`) while tasks are in flight, `task` and `summary`
styles flush the partial output of every unprinted task before exiting, so a killed run is still
diagnosable.

---

## `devutil discover`

```bash
devutil discover [--cwd <path>]
```

```
@cpdevtools/ts-dev-utilities
  dir:     /repo/packages/ts-dev-utilities
  scripts: build, format, github.actions.build, github.actions.pack, lint, test, typecheck

2 project(s) found
```

Use it to confirm which projects the runner will consider and whether they define the script you
are about to target. See [Project Discovery](Project-Discovery) for what counts as a project.

## `devutil graph`

```bash
devutil graph [--cwd <path>]
```

```
@cpdevtools/ts-dev-utilities  (no workspace deps)
@cpdevtools/ts-dev-utilities-cli
  └─ @cpdevtools/ts-dev-utilities
```

Only **workspace** dependencies appear — external packages are not edges. Both `dependencies` and
`devDependencies` are considered.

## `devutil dep-versions`

```bash
devutil dep-versions check .publish/deps.yml
devutil dep-versions fix   .publish/deps.yml
```

`check` reports drift and **exits 1 if any is found**, which makes it usable as a CI gate. `fix`
rewrites the files and exits 0. Both group their report by file:

```
  /repo/packages/cli/package.json
    typescript: ^5.6.0 → ^5.7.3

1 version(s) out of date
  Run 'devutil dep-versions fix <file>' to apply
```

The deps file format and the per-ecosystem rules are documented in
[Dependency Versions](Dependency-Versions).

## `devutil dev-link`

```bash
devutil dev-link status [pkg...] [--check] [--config <path>] [--cwd <path>]
devutil dev-link link   [pkg...]           [--config <path>] [--cwd <path>]
devutil dev-link unlink [pkg...]           [--config <path>] [--cwd <path>]
devutil dev-link auto                      [--config <path>] [--cwd <path>]
```

Repoints the installed `node_modules/<pkg>` symlinks of the packages mapped in
`.publish/dev-local.yml` (`--config` overrides the path) at local checkouts, in the workspace root
and in every member project that has its own copy. The lockfile and manifests are never touched.
Positional `pkg` names restrict the command to those packages; a name not in the map is an error.
When nothing is mapped, every subcommand prints a notice and exits 0.

| Subcommand         | Exits 1 when                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `status [--check]` | Only with `--check`: any entry is `published` or a real directory, or a link was reset by an install. |
| `link`             | Any checkout is `refused` for not being built, or the command is run under CI.                        |
| `unlink`           | Any link is `removed` without a restorable original (a `pnpm install` is then needed).                |
| `auto`             | Never — it is the `postinstall` hook, and only links when `DEV_LOCAL=true` and not under CI.          |

```
@cpdevtools/git-flow                  LINKED → ../git-flow/packages/git-flow (1.0.6)
@cpdevtools/git-flow (packages/cli)   published (1.0.5) — checkout not built (run pnpm build in ../git-flow/packages/git-flow)
```

The mechanism, the sidecar, the built-ness check and the library API are documented in
[Dev-Link](Dev-Link).

---

## Adding it to a workspace

The typical root `package.json`, using wireit:

```json
{
  "scripts": {
    "build": "devutil run build",
    "test": "devutil run test",
    "lint": "devutil run lint",
    "typecheck": "devutil run typecheck",
    "postinstall": "devutil dev-link auto"
  },
  "wireit": {
    "check.deps": { "command": "devutil dep-versions check .publish/deps.yml" },
    "fix.deps": { "command": "devutil dep-versions fix .publish/deps.yml" }
  }
}
```

In CI, git-flow's `test` action calls the same engine directly — you do not need a `devutil` step
in a workflow that already uses it. The `postinstall` hook is only needed by repos that carry a
`.publish/dev-local.yml`; it is a no-op everywhere `DEV_LOCAL` is not `true`.

Source:
[`packages/cli/src/bin.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/cli/src/bin.ts)
