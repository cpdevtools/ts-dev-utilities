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

## `DEV_LOCAL` and dev-link

Developing against local checkouts of `@cpdevtools/*` packages is done with **`devutil dev-link`**
(implemented in this repo — `src/dev-link/`), not by changing pnpm's resolution. `pnpm install`
always installs the published graph from the single committed root lockfile; `dev-link` then
repoints the installed `node_modules/@cpdevtools/<pkg>` symlinks at sibling checkouts listed in
`.publish/dev-local.yml`. The lockfile and manifests never change, pnpm's install fingerprint never
stats symlink targets, and `.bin` shims follow the repoint — so the overlay is invisible to pnpm and
survives everything short of a real install (which `postinstall: devutil dev-link auto` self-heals).

In this repo the map is currently **empty** (no `.publish/dev-local.yml`): the two workspace
packages already resolve each other via `workspace:*`. Consumer repos (git-flow, the webservice
repos) carry a map and a `postinstall` hook; `DEV_LOCAL=true` (exported ambiently by the
devcontainer) gates whether `auto` links, and `CI` always refuses.

The overlay is **layered, not transitive**: a repo that links a local `git-flow` gets that
checkout's own `node_modules` — including its published `ts-dev-utilities` — unless the git-flow
checkout is itself dev-linked. Each repo controls only its own overlay. The one behavioural
difference from the old pnpmfile approach: shared dependencies can exist twice (the consumer's
instance and the checkout's), which matters only for singleton/`instanceof`-sensitive libraries —
same behaviour and same fix (dep alignment) as classic `npm link`.

Historical note: this replaced a `.pnpmfile.cjs` that rewrote `@cpdevtools/*` deps to `file:`
paths under `DEV_LOCAL=true`. Because that mutated resolution — which pnpm 11 records and
frozen-validates — it required a second committed lockfile (`.pnpm-prod/`), pre-commit lockfile
surgery, and fingerprint deletion. All of that is gone; the actions auto-detect which layout a repo
uses by the presence of `.pnpm-prod/pnpm-lock.yaml`.

## The pre-commit hook

Husky's `pre-commit` is now just a guard: it fails the commit if a `file:/devcontainer` path
appears in the lockfile or a manifest (a leak from a pre-conversion tool run). There is no lockfile
regeneration step any more — the root lockfile is always in published mode because nothing rewrites
resolution locally.

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
