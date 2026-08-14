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

All commands accept `--cwd <path>` to point at a workspace root other than the current directory.

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
devutil run build --output-style full
devutil run github.actions.test --fail-fast --concurrency 4
```

### Options

| Flag                             | Default                      | Description                                                                   |
| -------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `--output-style <style>`         | `stream`, or `full` under CI | How task output is shown — see below.                                         |
| `--fail-fast`                    | off                          | Stop on first failure, cancelling in-flight tasks.                            |
| `--concurrency <n>`              | unlimited                    | Maximum projects running at once.                                             |
| `--cwd <path>`                   | current directory            | Workspace root.                                                               |
| `--missing-script <skip\|error>` | `skip`                       | `skip` treats a project without the script as a no-op pass; `error` fails it. |
| `--max-output <bytes>`           | `1000000`                    | Per-task capture cap. Does not limit `stream`.                                |

### Output styles

| Style     | Behaviour                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream`  | Live output as it happens, every line prefixed with `[project]`. Default outside CI.                                                                            |
| `full`    | Nothing during the run; afterwards every task's output, grouped under a per-project header, failures last so they sit closest to the summary. Default under CI. |
| `summary` | Captured output for **failed** tasks only.                                                                                                                      |
| `silent`  | Only the final pass/fail counts.                                                                                                                                |

CI is detected as `GITHUB_ACTIONS=true`, or `CI` set to anything other than empty, `false` or `0`.
Grouped (`full`) output is the CI default because interleaved parallel logs are hard to read in a
GitHub Actions log view.

### Summary and exit code

Every run ends with counts:

```
✅  Passed:    7
❌  Failed:    1
⏭   Skipped:   2
🚫  Cancelled: 0
—   No script: 3
```

The `No script:` line only appears when there were such tasks. **Exit code is `1` if any task
failed, otherwise `0`** — skipped and cancelled tasks do not by themselves fail the run, but they
only occur as a consequence of a failure.

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

---

## Wiring it into a workspace

The typical root `package.json`, using wireit:

```json
{
  "scripts": {
    "build": "devutil run build",
    "test": "devutil run test",
    "lint": "devutil run lint",
    "typecheck": "devutil run typecheck"
  },
  "wireit": {
    "check.deps": { "command": "devutil dep-versions check .publish/deps.yml" },
    "fix.deps": { "command": "devutil dep-versions fix .publish/deps.yml" }
  }
}
```

In CI, git-flow's `test` action calls the same engine directly — you do not need a `devutil` step
in a workflow that already uses it.

Source:
[`packages/cli/src/bin.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/cli/src/bin.ts)
