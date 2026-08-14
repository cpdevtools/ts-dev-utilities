# Development

For working **on** this repo. If you only want to consume the packages, see
[Getting Started](Getting-Started).

## Setup

```bash
git clone https://github.com/cpdevtools/ts-dev-utilities.git
cd ts-dev-utilities
pnpm install
```

`GITHUB_TOKEN` must be exported with `read:packages` — the repo's own `.npmrc` points the
`@cpdevtools` scope at GitHub Packages, and the git-flow devDependencies come from there.

Node `>= 24`, pnpm pinned at `11.5.0` via `packageManager`.

## Root scripts

| Command          | What it does                                                                    |
| ---------------- | ------------------------------------------------------------------------------- |
| `pnpm build`     | `devutil run build` — dependency-ordered build of both packages                 |
| `pnpm test`      | `devutil run test`                                                              |
| `pnpm lint`      | `devutil run lint`                                                              |
| `pnpm typecheck` | `devutil run typecheck`                                                         |
| `pnpm format`    | prettier over the repo, syncpack format, then each project's own `format`       |
| `pnpm check`     | `check.deps` + `check.syncpack` — fails on dependency drift or version mismatch |
| `pnpm fix`       | `fix.deps` → `fix.syncpack` → `format`, plus deleting local tags                |
| `pnpm clean`     | `git clean -dfX` then reinstall                                                 |
| `pnpm reset`     | `git reset --hard` then reinstall                                               |

The repo uses its own `devutil` (`@cpdevtools/ts-dev-utilities-cli` is a `workspace:*`
devDependency), so a broken runner breaks the build of the runner. If you get into that state,
build the library package directly with `pnpm --filter @cpdevtools/ts-dev-utilities build`.

## Task graph

Per-package tasks are [wireit](https://github.com/google/wireit) tasks, so they cache and declare
their own inputs:

| Package            | Task        | Command                | Depends on                  |
| ------------------ | ----------- | ---------------------- | --------------------------- |
| `ts-dev-utilities` | `build`     | `tsup`                 | —                           |
|                    | `test`      | `vitest run`           | `build`                     |
|                    | `typecheck` | `tsc --noEmit`         | —                           |
|                    | `lint`      | `eslint src --ext .ts` | —                           |
| `cli`              | `build`     | `tsup`                 | `../ts-dev-utilities:build` |
|                    | `typecheck` | `tsc --noEmit`         | `../ts-dev-utilities:build` |

Each package also defines `github.actions.build` (`tsup`) and `github.actions.pack`
(`gitflow pack`) — those are the names CI targets. See [Gotchas](Gotchas) on why the names matter.

## Tests

Vitest, globals enabled, node environment, v8 coverage.

```bash
pnpm --filter @cpdevtools/ts-dev-utilities test
pnpm --filter @cpdevtools/ts-dev-utilities exec vitest        # watch
pnpm --filter @cpdevtools/ts-dev-utilities exec vitest --coverage
```

The scheduler suite injects fakes through `RunOptions._discover` and `_exec`, so it exercises
ordering, failure propagation, fail-fast cancellation, concurrency caps, `missingScript` behaviour,
output truncation, and both hooks without spawning real processes. Discovery is tested against real
temp directories, including symlink and invalid-manifest cases.

## `DEV_LOCAL`

`.pnpmfile.cjs` supports `DEV_LOCAL=true pnpm install` to resolve `@cpdevtools/*` dependencies from
sibling checkouts via `file:` instead of the registry. In this repo the local-package map is
currently **empty** — the hook is in place for when it is needed, and for symmetry with git-flow,
where it is actively used to develop against a sibling `ts-dev-utilities`.

Hooks are only exported when `DEV_LOCAL=true`, so a normal install can never produce a lockfile
checksum mismatch in CI.

## The pre-commit hook

Husky's `pre-commit` regenerates two lockfiles and stages them:

1. `.pnpm-prod/pnpm-lock.yaml` — the published-mode lockfile CI installs from.
2. The root `pnpm-lock.yaml`, normalised to published mode.

Both run with `DEV_LOCAL=false` and `--lockfile-only`, so `node_modules` is untouched and local
`DEV_LOCAL` links keep working. The second step exists because CI installs from `.pnpm-prod`, but
any nested `pnpm run` in CI checks `node_modules` against the **root** lockfile — a dev-mode
(`file:`) lockfile there fails the frozen install it triggers.

If the hook fails, the commit is aborted with pnpm's output; fix the dependency problem rather than
bypassing it.

## Dependency consistency

Two tools, different jobs:

- **[dep-versions](Dependency-Versions)** (`.publish/deps.yml`) decides _which version_ a
  dependency should be, across every ecosystem in the repo.
- **syncpack** (`.syncpackrc.yml`) enforces _consistency and shape_: workspace-internal
  dependencies must use `workspace:*`, external ones use caret ranges, and `package.json` keys are
  sorted into a fixed order.

`pnpm fix` runs them in the right order — pin first, reconcile after. `pnpm check` runs both
read-only and is what CI enforces.

## Adding a new subpath export

Four places, all required, or the build succeeds and the import fails at runtime:

1. `src/<name>/index.ts` — the barrel.
2. `tsup.config.ts` — add `'<name>/index': 'src/<name>/index.ts'` to `entry`.
3. `package.json` `exports` — add `"./<name>"` with `types` and `default` pointing into `dist/`.
4. [API Reference](API-Reference) — add the entry point and its exports.

Remember the build is **CJS only**; an ESM-only dependency has to be added to `noExternal` so tsup
inlines it, as `globby` is.

## Editing these pages

This wiki is generated from the [`wiki/`](https://github.com/cpdevtools/ts-dev-utilities/tree/main/wiki)
directory of the code repository. **Edit the files there, in a normal PR** — pushing to `main` runs
`publish-wiki.yml`, which calls git-flow's
[`publish-wiki`](https://github.com/cpdevtools/git-flow/tree/main/actions/publish-wiki) action and
mirrors the directory into the wiki.

Two consequences:

- Anything written through the wiki's own edit UI is overwritten by the next sync.
- The sync is a mirror, so deleting a page from `wiki/` deletes it from the wiki.

Pages are prettier-formatted along with the rest of the repo (`wiki/` is not in `.prettierignore`),
so `pnpm format` keeps them consistent. Filenames are page titles — `Getting-Started.md` publishes as
_Getting Started_ — and `_Sidebar.md` / `_Footer.md` are the navigation panel and footer. Link
between pages by filename without the extension; relative links into the code repo do not resolve
from a wiki, so use full URLs for those.

A docs-only change still opens a release PR, since `create-release-pr.yml` runs on every push. Merge
or leave it as you would for any other non-release commit.
