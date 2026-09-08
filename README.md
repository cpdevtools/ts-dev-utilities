# @cpdevtools/ts-dev-utilities

TypeScript development utilities for project discovery, JSON operations, and common tooling. Also includes a **dependency-driven parallel script runner**, cross-ecosystem **dependency-version pinning**, a **dev-link** overlay for working against local checkouts, and the `devutil` CLI.

## Installation

```bash
npm install @cpdevtools/ts-dev-utilities
```

## Entry points

| Import path                                 | Contents                                   |
| ------------------------------------------- | ------------------------------------------ |
| `@cpdevtools/ts-dev-utilities`              | `globby`, `changeCase` re-exports          |
| `@cpdevtools/ts-dev-utilities/project`      | Project discovery and dependency graph     |
| `@cpdevtools/ts-dev-utilities/runner`       | Parallel script runner                     |
| `@cpdevtools/ts-dev-utilities/artifacts`    | Artifact descriptor types and writer       |
| `@cpdevtools/ts-dev-utilities/dep-versions` | Cross-ecosystem dependency-version pinning |
| `@cpdevtools/ts-dev-utilities/dev-link`     | Local-checkout symlink overlay             |
| `@cpdevtools/ts-dev-utilities/json`         | JSONC parse/stringify                      |

## Features

### Parallel Script Runner

Run one or more scripts across every project in a workspace, ordered by the dependency graph. Projects start as soon as all their workspace dependencies have passed — not in fixed waves.

```typescript
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';

const summary = await runScripts({
  scripts: ['github.actions.build', 'github.actions.test'],
  cwd: process.cwd(),
  failFast: false, // keep-going (default); true = stop on first failure
  concurrency: 4, // max parallel tasks; omit for unlimited
  missingScript: 'skip', // 'skip' (default) or 'error'
});

console.log(`passed: ${summary.passed.length}, failed: ${summary.failed.length}`);
```

**Task outcomes:** `passed`, `failed`, `skipped` (a dependency failed), `cancelled` (fail-fast), `no-script` (project doesn't define the target script — treated as a pass).

### `devutil` CLI

A lightweight CLI installed as the `devutil` binary.

```bash
# Run a script across the workspace, dependency-ordered
devutil run github.actions.test

# Run multiple scripts (build then test per project)
devutil run github.actions.build github.actions.test

# Stop on first failure, cancel in-flight tasks
devutil run github.actions.test --fail-fast

# Cap parallelism
devutil run github.actions.test --concurrency 4

# Group each project's output into a block as it finishes (the default under CI)
devutil run build --output-style task

# Treat missing scripts as an error instead of a no-op
devutil run github.actions.test --missing-script error

# List all discovered projects and their scripts
devutil discover

# Print the workspace dependency graph
devutil graph

# Report drift against pinned versions (exit 1 if any), or apply them
devutil dep-versions check .publish/deps.yml
devutil dep-versions fix .publish/deps.yml

# Point installed packages at local checkouts (see Dev-link below)
devutil dev-link status --check
devutil dev-link link
```

`devutil run` options:

| Flag                                             | Default                      | Description                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--output-style <stream\|task\|summary\|silent>` | `stream`, or `task` under CI | `stream` = live, `[project]`-prefixed lines; `task` = per-project block as each task finishes; `summary` = everything at the end, failures last; `silent` = counts only. |
| `--fail-fast`                                    | off                          | Stop on first failure, cancelling in-flight tasks.                                                                                                                       |
| `--concurrency <n>`                              | unlimited                    | Maximum projects running at once. Integer ≥ 1. With `task` and `--concurrency 1`, output is relayed verbatim as it is produced.                                          |
| `--cwd <path>`                                   | current directory            | Workspace root (accepted by every command).                                                                                                                              |
| `--missing-script <skip\|error>`                 | `skip`                       | `skip` treats a project without the script as a no-op pass; `error` fails it.                                                                                            |
| `--max-output <bytes>`                           | `1000000`                    | Per-task capture cap. Integer ≥ 1. Does not limit `stream`.                                                                                                              |

Flag parsing is strict: value flags (`--output-style`, `--concurrency`, `--cwd`, `--missing-script`, `--max-output`, `--config`) must be followed by a value, boolean flags (`--fail-fast`, `--check`) take none, and an unknown `--flag` is an error naming the flag. Any such error is printed to stderr and exits 1. A run exits 1 if any task failed; the summary always names the failed projects.

### Dependency Versions

Declare the version a dependency should have once, then check or rewrite every place it is written. Handlers cover **npm** (every `package.json` including the workspace root, plus `# dep-version:` annotated `ARG`s and literal `name@version` install sites in Dockerfiles), **dotnet** (`Directory.Packages.props`, `*.csproj`), **docker** (`FROM` in Dockerfiles, `image:` in compose files) and **github-actions** (`uses:` in workflows and `action.yml`).

```yaml
# .publish/deps.yml
npm:
  typescript: '^5.7.3'
docker:
  node: '24-alpine'
github-actions:
  actions/checkout: 'v7'
```

```typescript
import { checkDepVersions, fixDepVersions } from '@cpdevtools/ts-dev-utilities/dep-versions';

const drift = await checkDepVersions('.publish/deps.yml', process.cwd()); // DepChange[]
const applied = await fixDepVersions('.publish/deps.yml', process.cwd());
```

Protocol specifiers (`workspace:*`, `link:`, `file:`, …) and interpolated Docker tags are never rewritten. `devutil dep-versions check <file>` exits 1 when anything is out of date.

### Dev-link

Develop against local checkouts of published packages without changing the lockfile or any manifest. `.publish/dev-local.yml` maps package names to checkout directories; after `pnpm install` has installed the published graph, `devutil dev-link` repoints the installed `node_modules/<pkg>` symlinks — in the workspace root and in every member project that has its own copy — at those checkouts. The overlay is invisible to pnpm, and the original symlink targets are recorded in `node_modules/.dev-link.json` so `unlink` can put them back.

```yaml
# .publish/dev-local.yml
packages:
  '@cpdevtools/git-flow': '../git-flow/packages/git-flow'
```

```bash
devutil dev-link status --check   # one row per install location; exit 1 unless every installed package is linked
devutil dev-link link             # refuses under CI and refuses an unbuilt checkout (exit 1)
devutil dev-link unlink           # restore the pnpm-installed symlinks (exit 1 if one could not be restored)
devutil dev-link auto             # postinstall: link only when DEV_LOCAL=true and not CI; always exits 0
```

Consumer wiring is a `"postinstall": "devutil dev-link auto"` script plus `DEV_LOCAL=true` in the development environment. The overlay is layered, not transitive — a linked checkout brings its own `node_modules`.

```typescript
import {
  loadDevLinkConfig,
  linkPackages,
  getDevLinkStatus,
} from '@cpdevtools/ts-dev-utilities/dev-link';

const config = await loadDevLinkConfig(process.cwd()); // null when nothing is mapped
if (config) console.log(await getDevLinkStatus(config, { cwd: process.cwd() }));
```

### Artifact Descriptors

Types and a writer for the `*.artifact.yml` descriptors that git-flow's release pipeline consumes.

```typescript
import { writeArtifact } from '@cpdevtools/ts-dev-utilities/artifacts';

await writeArtifact({
  project: '@myorg/pkg',
  artifacts: [{ type: 'npm', name: '@myorg/pkg', registries: ['github-npm'], floatingTags: false }],
});
```

`floatingTags: false` on an `npm` or `docker-image` artifact publishes the version only — no `latest` / `next` / channel dist-tags or image tags are moved at publish time.

### Project Discovery

Find and analyze projects in a workspace:

```typescript
import { discoverProjects, buildDependencyGraph } from '@cpdevtools/ts-dev-utilities/project';

const projects = await discoverProjects({
  cwd: process.cwd(),
  patterns: ['packages/*/package.json'],
});

// Build a dependency graph from the discovered projects
const graph = buildDependencyGraph(projects);

for (const node of graph.getAllNodes()) {
  console.log(`${node.name} depends on: ${[...node.dependencies].join(', ') || 'nothing'}`);
}

// Detect cycles before processing
const cycle = graph.detectCycle();
if (cycle) throw new Error(`Cycle: ${cycle.join(' → ')}`);

// Topological wave ordering (for batch-style processing)
const batches = graph.getTopologicalBatches();
```

### JSON Utilities

Parse JSON with comments (JSONC):

```typescript
import { parseJson, stringifyJson } from '@cpdevtools/ts-dev-utilities/json';

const data = parseJson('{ "key": "value" /* comment */ }');
const json = stringifyJson(data, { spaces: 2 });
```

### Re-exports

Common utilities re-exported for convenience:

```typescript
import { globby } from '@cpdevtools/ts-dev-utilities';
import * as changeCase from '@cpdevtools/ts-dev-utilities';
```

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm run build

# Type-check
pnpm run typecheck
```

## License

MIT
