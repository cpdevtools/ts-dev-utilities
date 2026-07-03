# @cpdevtools/ts-dev-utilities

TypeScript development utilities for project discovery, JSON operations, and common tooling. Also includes a **dependency-driven parallel script runner** and the `devutil` CLI.

## Installation

```bash
npm install @cpdevtools/ts-dev-utilities
```

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

# Treat missing scripts as an error instead of a no-op
devutil run github.actions.test --missing-script error

# List all discovered projects and their scripts
devutil discover

# Print the workspace dependency graph
devutil graph
```

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
