# Project Discovery & Dependency Graph

```ts
import {
  discoverProjects,
  buildDependencyGraph,
  DependencyGraph,
} from '@cpdevtools/ts-dev-utilities/project';
```

Everything else in the library that needs to know "what projects are here and how do they relate"
goes through this module — the runner, the dep-versions npm handler, and both of `devutil`'s
inspection commands.

## `discoverProjects(options?)`

```ts
const projects = await discoverProjects({
  cwd: process.cwd(),
  patterns: ['packages/*/package.json'], // optional
  ignore: ['**/fixtures/**'], // optional
});
```

| Option     | Default                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| `cwd`      | `process.cwd()`                                                                               |
| `patterns` | Derived from `pnpm-workspace.yaml`, else `['**/package.json']`                                |
| `ignore`   | `['**/node_modules/**', '**/dist/**', '**/.pnpm-prod/**']` plus any negated workspace entries |

### How patterns are derived

When you do **not** pass `patterns`, discovery reads `pnpm-workspace.yaml` at `cwd` and turns each
member glob into a `package.json` glob:

```yaml
packages:
  - 'packages/*'      →  packages/*/package.json
  - '!packages/junk'  →  added to ignore
```

This has two consequences worth internalising:

- **Discovery is scoped to actual workspace members.** A stray `package.json` in a fixture
  directory outside the member globs is not a project.
- **The workspace root is excluded**, because `packages/*/package.json` cannot match
  `./package.json`. The root is not a buildable member. (The npm dep-versions handler adds the root
  back explicitly, because that is where shared tooling devDependencies live — see
  [Dependency Versions](Dependency-Versions).)

If there is no `pnpm-workspace.yaml`, or it has no usable `packages` array, discovery falls back to
a recursive `**/package.json` search.

### Behaviour details

- **Symlinked directories are never traversed** (`followSymbolicLinks: false`). Real workspace
  members are real directories, and following symlinks can recurse infinitely through nested
  installs — a `.pnpm-prod` directory linking back to the repo root is one such shape.
- **`package.json` is parsed as JSONC**, so comments and trailing commas are tolerated.
- **An unparseable `package.json` is skipped with a `console.warn`**, not thrown. One broken
  manifest does not abort discovery of the rest.
- A project with no `name` field falls back to its directory name.

### The `Project` shape

```ts
interface Project {
  packageJsonPath: string; // absolute
  directory: string; // absolute, dirname of the above
  packageJson: PackageJson; // fully parsed
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
```

`ProjectInfo` is an alias for `Project` — both names appear in the codebase and either is fine.
`PackageJson` is a loose interface with the common fields typed and an index signature for
everything else.

## `buildDependencyGraph(projects, workspaceProjects?)`

```ts
const graph = buildDependencyGraph(projects);
```

Edges are drawn from both `dependencies` and `devDependencies`, and **only** when the dependency
name matches another discovered project. External packages never become edges, and the version
range is irrelevant — a `workspace:*` and a `^1.2.3` pointing at a sibling are both edges.

The optional second argument is a set of names known to be in the workspace. It does not add
edges; it only produces a warning when a project depends on a workspace member that discovery did
not find — useful for catching a member excluded by a bad glob.

## `DependencyGraph`

| Member                    | Returns                       | Notes                                                             |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `addProject(project)`     | `void`                        | Idempotent per name.                                              |
| `addDependency(from, to)` | `void`                        | Throws if either name is not in the graph.                        |
| `getNode(name)`           | `DependencyNode \| undefined` |                                                                   |
| `getAllNodes()`           | `DependencyNode[]`            |                                                                   |
| `getAllProjectNames()`    | `string[]`                    |                                                                   |
| `detectCycle()`           | `string[] \| undefined`       | The path forming a cycle, or `undefined`.                         |
| `getTopologicalBatches()` | `ProjectInfo[][]`             | Waves of projects safe to process in parallel. Throws on a cycle. |

```ts
interface DependencyNode {
  name: string;
  project: ProjectInfo;
  dependencies: Set<string>; // this project depends on these
  dependents: Set<string>; // these depend on this project
}
```

Both directions are tracked, which is what lets the scheduler unblock dependents and propagate
skips without re-walking the graph.

### Batches vs the ready-set

`getTopologicalBatches()` returns fixed waves: batch _n+1_ does not begin until all of batch _n_ is
done. That is the right model for batch-style processing (git-flow's build-pack uses this shape),
but it wastes wall-clock when one project in a wave is much slower than the rest.

The [runner](Parallel-Script-Runner) deliberately does **not** use it. It walks `dependencies` /
`dependents` directly so each project starts as soon as its own dependencies pass.

## Example

```ts
import { discoverProjects, buildDependencyGraph } from '@cpdevtools/ts-dev-utilities/project';

const projects = await discoverProjects({ cwd: process.cwd() });
const graph = buildDependencyGraph(projects);

const cycle = graph.detectCycle();
if (cycle) throw new Error(`Cycle: ${cycle.join(' → ')} → ${cycle[0]}`);

for (const node of graph.getAllNodes()) {
  console.log(`${node.name} → ${[...node.dependencies].join(', ') || '(nothing)'}`);
}

for (const [i, batch] of graph.getTopologicalBatches().entries()) {
  console.log(`wave ${i}: ${batch.map((p) => p.name).join(', ')}`);
}
```

Source:
[`src/project/discover.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/project/discover.ts) ·
[`src/project/dependencyGraph.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/project/dependencyGraph.ts)
