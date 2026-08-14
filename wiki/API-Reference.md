# API Reference

Everything exported by `@cpdevtools/ts-dev-utilities`, by entry point. Each section links to the
page that explains the behaviour.

## Entry points

| Import path                                 | Contents                             |
| ------------------------------------------- | ------------------------------------ |
| `@cpdevtools/ts-dev-utilities`              | `globby`, `changeCase` re-exports    |
| `@cpdevtools/ts-dev-utilities/project`      | Discovery and dependency graph       |
| `@cpdevtools/ts-dev-utilities/runner`       | The parallel script runner           |
| `@cpdevtools/ts-dev-utilities/dep-versions` | Cross-ecosystem version pinning      |
| `@cpdevtools/ts-dev-utilities/artifacts`    | Artifact descriptor types and writer |
| `@cpdevtools/ts-dev-utilities/json`         | JSONC parse/stringify                |

There is no all-in-one barrel; the root entry is only the re-exports.

---

## `.` — root

| Export          | Kind      | Notes                                                                                   |
| --------------- | --------- | --------------------------------------------------------------------------------------- |
| `globby`        | function  | Re-export of [globby](https://github.com/sindresorhus/globby).                          |
| `GlobbyOptions` | type      | globby's `Options`.                                                                     |
| `changeCase`    | namespace | `import * as changeCase from 'change-case'` — `camelCase`, `pascalCase`, `kebabCase`, … |

```ts
import { globby, changeCase } from '@cpdevtools/ts-dev-utilities';

const files = await globby(['src/**/*.ts']);
changeCase.pascalCase('my-service'); // 'MyService'
```

---

## `./project` → [Project Discovery](Project-Discovery)

| Export                    | Kind     | Signature / shape                                                                                                     |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `discoverProjects`        | function | `(options?: ProjectDiscoveryOptions) => Promise<Project[]>`                                                           |
| `buildDependencyGraph`    | function | `(projects: ProjectInfo[], workspaceProjects?: Set<string>) => DependencyGraph`                                       |
| `DependencyGraph`         | class    | `addProject`, `addDependency`, `getNode`, `getAllNodes`, `getAllProjectNames`, `detectCycle`, `getTopologicalBatches` |
| `Project`                 | type     | `packageJsonPath`, `directory`, `packageJson`, `name`, `dependencies?`, `devDependencies?`                            |
| `ProjectInfo`             | type     | Alias of `Project`                                                                                                    |
| `ProjectDiscoveryOptions` | type     | `cwd?`, `patterns?`, `ignore?`                                                                                        |
| `PackageJson`             | type     | Common fields typed, index signature for the rest                                                                     |
| `DependencyNode`          | type     | `name`, `project`, `dependencies: Set`, `dependents: Set`                                                             |

---

## `./runner` → [Parallel Script Runner](Parallel-Script-Runner)

| Export       | Kind     | Signature / shape                                                                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `runScripts` | function | `(options: RunOptions) => Promise<RunSummary>`                                                                                        |
| `RunOptions` | type     | `scripts`, `concurrency?`, `failFast?`, `cwd?`, `env?`, `missingScript?`, `maxOutputBytes?`, `onOutput?`, `beforeTask?`, `afterTask?` |
| `RunSummary` | type     | `passed`, `failed`, `skipped`, `cancelled`, `noScript` — all `TaskResult[]`                                                           |
| `TaskResult` | type     | `project`, `projectDir`, `scripts`, `state`, `durationMs`, `output?`, `truncated?`                                                    |
| `TaskState`  | type     | `'pending' \| 'running' \| 'passed' \| 'failed' \| 'skipped' \| 'cancelled' \| 'no-script'`                                           |

Defaults: `concurrency: Infinity`, `failFast: false`, `cwd: process.cwd()`,
`missingScript: 'skip'`, `maxOutputBytes: 1_000_000`.

---

## `./dep-versions` → [Dependency Versions](Dependency-Versions)

| Export              | Kind     | Signature / shape                                                                      |
| ------------------- | -------- | -------------------------------------------------------------------------------------- |
| `checkDepVersions`  | function | `(filePath: string, cwd?: string, registry?: HandlerRegistry) => Promise<DepChange[]>` |
| `fixDepVersions`    | function | Same signature; writes.                                                                |
| `HandlerRegistry`   | class    | `register(handler)` (chainable), `get(name)`, `getAll()`                               |
| `defaultRegistry`   | const    | Pre-built with `npm`, `dotnet`, `docker`, `github-actions`                             |
| `registerHandler`   | function | `(handler: DepVersionHandler) => void` — registers on `defaultRegistry`                |
| `DepChange`         | type     | `file`, `name`, `from`, `to`                                                           |
| `DepVersionHandler` | type     | `name`, `check(cwd, deps)`, `fix(cwd, deps)`                                           |
| `DepsFile`          | type     | `npm?`, `dotnet?`, `docker?`, `github-actions?`, plus an index signature               |

---

## `./artifacts` → [Artifacts](Artifacts)

| Export                      | Kind     | Notes                                                                                                          |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `writeArtifact`             | function | `(descriptor: ProjectArtifactDescriptor) => Promise<void>`. Requires `ARTIFACT_OUTPUT_DIR` and `PROJECT_NAME`. |
| `ProjectArtifactDescriptor` | type     | `project`, `artifacts: Artifact[]`                                                                             |
| `Artifact`                  | type     | Union of the six below                                                                                         |
| `NpmArtifact`               | type     | `type: 'npm'`                                                                                                  |
| `DockerArtifact`            | type     | `type: 'docker-image'` — renamed from `'docker'`                                                               |
| `NuGetArtifact`             | type     | `type: 'nuget'`                                                                                                |
| `ReleaseAttachment`         | type     | `type: 'release-attachment'`                                                                                   |
| `DeployArtifact`            | type     | `type: 'deploy'`                                                                                               |
| `CustomArtifact`            | type     | Any other `type` string, for plugin-defined artifacts                                                          |

---

## `./json` → [JSON Utilities](JSON-Utilities)

| Export             | Kind     | Signature                                                          |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `parseJson`        | function | `(text: string) => unknown` — comments and trailing commas allowed |
| `stringifyJson`    | function | `(value: unknown, options?: StringifyOptions) => string`           |
| `StringifyOptions` | type     | `spaces?` (default `2`), `insertFinalNewline?` (default `true`)    |

---

## Not public API

`RunOptions._discover` and `RunOptions._exec` exist to inject fakes in the scheduler's unit tests.
They are typed and reachable, but they are not part of the contract and may change without a
version bump.
