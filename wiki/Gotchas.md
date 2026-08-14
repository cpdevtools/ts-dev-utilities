# Gotchas

Behaviour that is correct by design but easy to misread. Each entry describes what happens, and what
goes wrong if you assume otherwise.

## A passing test run that ran no tests

`missingScript` defaults to `'skip'`, so a project defining **none** of the target scripts is
reported `no-script`, counted as a pass, and unblocks its dependents. Combined with git-flow's
`test` action — where `mode` selects _script names_, not behaviours — a repo whose tests live under
a plain `test` script will pass CI without ever running them.

`mode: test-optional` runs `github.actions.build` and `github.actions.test`. **Name the script
`github.actions.test`.** If you would rather fail loudly, run with `--missing-script error`, which
marks such projects `failed` and skips their dependents.

Check what will actually run before trusting a green run:

```bash
devutil discover | grep -A2 'my-project'
```

## `skipped` and `cancelled` do not fail the run on their own

`devutil run` exits 1 only when `summary.failed` is non-empty. Skips and cancellations are always
downstream of a failure, so in practice the exit code is right — but if you post-process a
`RunSummary` yourself, do not treat a non-empty `skipped` bucket as the failure signal.

## The workspace root is not a project

Discovery derives its globs from `pnpm-workspace.yaml`, so `packages/*/package.json` cannot match
the root manifest. Scripts defined only at the root are never run by `devutil run`, and the root is
absent from `devutil discover` and `devutil graph`.

The npm dep-versions handler is the one exception — it adds the root back explicitly, because that
is where shared tooling devDependencies live.

## `workspace:` and other protocol specifiers are never rewritten

The npm dep-versions handler skips any specifier containing a protocol (`workspace:`, `link:`,
`file:`, `portal:`, `catalog:`, `npm:` aliases, git and tarball URLs). Putting
`'@cpdevtools/ts-dev-utilities': '^0.4.0'` in `deps.yml` will **not** change a sibling's
`workspace:*` — and that is deliberate. Rewriting it would swap a live workspace link for a
published package, so the package would silently build against its last release instead of the
sibling source.

## Interpolated Docker tags are left alone

`image: repo:${DEPLOY_IMAGE_TAG}` in a deploy bundle is the released version supplied at deploy
time, not a pin. The docker handler skips any tag starting with `$`, and the npm handler skips
`ARG` values containing `${`. Baking a literal over either ships the wrong thing.

## `minimumReleaseAgeExclude` entries must be bare names

pnpm stops at the first entry matching a package, so `'@cpdevtools/git-flow@1.0.0-rc.0'` shadows
every later entry for that package. The shadowing is silent — it surfaces as CI failing on a
release that was explicitly meant to be allowed. List bare package names only.

## The packages are CommonJS

tsup builds `format: ['cjs']` only. Both `require()` and `import` work from Node, but do not expect
ESM-only features (top-level `import.meta.url` semantics, conditional ESM exports) from the
published bundles. ESM-only dependencies must be inlined via `noExternal` — that is why `globby` is
bundled rather than declared external.

## pnpm must be on `PATH`

The runner spawns `pnpm run <script>`. There is no package-manager detection and no npm/yarn
fallback. In a container image that installs `devutil` globally, pnpm has to be there too.

## Output capture is capped, streaming is not

`maxOutputBytes` (1 MB default) bounds what is buffered into `TaskResult.output`, and `truncated`
is set when the cap is hit — the tail is what survives being reported. `onOutput` / `--output-style
stream` is independent and unbounded, so a runaway task can still flood the log.

## Concurrency is unlimited by default

`runScripts` defaults to `Infinity`. On a wide graph that starts every independent project at once,
which is usually what you want locally and occasionally not what you want on a small CI runner.
Pass `--concurrency <n>`.

## A dependency cycle throws before anything runs

`runScripts` calls `detectCycle()` up front and throws `Circular dependency detected: a → b → a`.
This is not a task failure and produces no `RunSummary` — it is an exception out of the call.
`devutil run` reports it as a top-level error with exit code 1.

## Hook failures are not symmetric

If `beforeTask` throws, the project fails, its scripts never run, **and `afterTask` is not called**.
If `afterTask` throws, the recorded result is overridden to `failed` and its message is appended to
the captured output. Both skip dependents. `afterTask` is also never called for `no-script` tasks,
so it is not a reliable "ran for every project" hook.

## An unparseable `package.json` is a warning, not an error

Discovery skips it with a `console.warn` and carries on. A project can silently vanish from the run
because of a JSON syntax error. If a project seems to be missing, check `devutil discover` output
for warnings first.

## An unknown deps-file section is skipped with a warning

A typo like `npms:` in `.publish/deps.yml` does not fail — the engine logs
`no handler registered for section "npms" — skipping` and reports zero drift for it. `check` then
exits 0 and looks clean.
