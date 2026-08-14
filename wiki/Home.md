# ts-dev-utilities

Generic workspace tooling for pnpm/TypeScript monorepos: project discovery, a real dependency
graph, a dependency-driven parallel script runner, JSONC helpers, artifact descriptors, and a
cross-ecosystem dependency-version pinner — plus the `devutil` CLI that exposes them.

Everything here is **deliberately generic**. Nothing in this repo knows about releases, GitHub
Actions, or git. That coupling lives one layer up, in
[`git-flow`](https://github.com/cpdevtools/git-flow), which consumes these primitives.

## Packages

| Package                            | What it is                                                        | Entry     |
| ---------------------------------- | ----------------------------------------------------------------- | --------- |
| `@cpdevtools/ts-dev-utilities`     | The library. Six entry points — a root barrel plus five subpaths. | `import`  |
| `@cpdevtools/ts-dev-utilities-cli` | Ships the `devutil` binary — a thin CLI over the library.         | `devutil` |

Both are published to **GitHub Packages** under the `@cpdevtools` scope, so installing them needs
an `.npmrc` — see [Getting Started](Getting-Started).

## What it does

| Subpath          | Capability                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `./project`      | Find every workspace member from `pnpm-workspace.yaml`, build a dependency graph, detect cycles.  |
| `./runner`       | Run one or more npm scripts across the whole workspace, dependency-ordered, in parallel.          |
| `./dep-versions` | Pin one version of a dependency across `package.json`, `.csproj`, Dockerfiles and workflow files. |
| `./artifacts`    | Types and writer for the `*.artifact.yml` descriptors git-flow's build-pack consumes.             |
| `./json`         | Parse JSON with comments and trailing commas (`tsconfig.json`, etc.).                             |
| `.`              | Convenience re-exports of `globby` and `change-case`.                                             |

## Start here

- **[Getting Started](Getting-Started)** — install, authenticate, first commands.
- **[Architecture](Architecture)** — how the pieces fit, and where git-flow plugs in.
- **[Parallel Script Runner](Parallel-Script-Runner)** — the scheduler, its semantics and hooks.
- **[devutil CLI](devutil-CLI)** — every command and flag.
- **[API Reference](API-Reference)** — everything exported, in one table.

### Reference pages

- [Project Discovery & Dependency Graph](Project-Discovery)
- [Dependency Versions](Dependency-Versions)
- [Artifacts](Artifacts)
- [JSON Utilities](JSON-Utilities)

### Working on the repo

- [Development](Development) — build, test, `DEV_LOCAL`, the wireit task graph.
- [Releasing](Releasing) — the `0.0.0-MAIN` placeholder, release PRs, registries.
- [Gotchas](Gotchas) — the traps that have actually bitten people.

## Relationship to git-flow

`ts-dev-utilities` and `git-flow` depend on each other and **move in lockstep**: git-flow consumes
the runner and the artifact types, and this repo consumes git-flow's release tooling to publish
itself. That mutual dependency is why `@cpdevtools/ts-dev-utilities` is listed in git-flow's
`minimumReleaseAgeExclude` — a fresh release has to be consumable the day it publishes.

Practically: git-flow's `test` action is a thin adapter that maps `mode` → script names, calls
`runScripts`, and renders GitHub annotations. The scheduling itself all happens here.
