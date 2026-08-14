# Getting Started

## Requirements

|                 |                                                                                       |
| --------------- | ------------------------------------------------------------------------------------- |
| Node            | `>= 24` (both packages declare it in `engines`)                                       |
| Package manager | pnpm — the runner shells out to `pnpm run <script>`, so pnpm must be on `PATH`        |
| Module format   | The published bundles are **CommonJS**. Both `require()` and `import` work from Node. |

## Authenticating to GitHub Packages

`@cpdevtools/*` is published to **GitHub Packages**, not the public npm registry. Without an
`.npmrc` telling npm where the scope lives, `npm install @cpdevtools/ts-dev-utilities` fails with
a 404.

Add this to the consuming repo's `.npmrc`:

```ini
@cpdevtools:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs the `read:packages` scope. In GitHub Actions, grant the job
`permissions: packages: read` and pass `secrets.GITHUB_TOKEN`.

## Install

```bash
pnpm add -D @cpdevtools/ts-dev-utilities        # the library
pnpm add -D @cpdevtools/ts-dev-utilities-cli    # the devutil binary
```

The CLI package depends on the library, so installing the CLI alone is enough if you only want
`devutil`.

## Entry points

The library has no barrel that re-exports everything — import from the subpath you need:

```ts
import { discoverProjects, buildDependencyGraph } from '@cpdevtools/ts-dev-utilities/project';
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';
import { checkDepVersions, fixDepVersions } from '@cpdevtools/ts-dev-utilities/dep-versions';
import { writeArtifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import { parseJson, stringifyJson } from '@cpdevtools/ts-dev-utilities/json';
import { globby, changeCase } from '@cpdevtools/ts-dev-utilities';
```

The root entry (`.`) is only the convenience re-exports of `globby` and `change-case`. Everything
functional lives under a subpath. See [API Reference](API-Reference).

## First commands

From the root of any pnpm workspace:

```bash
# What does devutil see?
devutil discover

# How are those projects wired together?
devutil graph

# Run a script across every project, dependency-ordered
devutil run build
```

`discover` reads `pnpm-workspace.yaml` to decide what counts as a project, so if the output is
empty or surprising, that file is the first place to look. See
[Project Discovery](Project-Discovery).

## First use from code

```ts
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';

const summary = await runScripts({
  scripts: ['github.actions.build', 'github.actions.test'],
  cwd: process.cwd(),
  failFast: false,
  concurrency: 4,
});

console.log(`passed ${summary.passed.length}, failed ${summary.failed.length}`);
if (summary.failed.length > 0) process.exit(1);
```

A project that defines _neither_ script is reported as `no-script` and counted as a pass — that is
the default behaviour, and a common source of confusion. See [Gotchas](Gotchas).

## Where to go next

- [Parallel Script Runner](Parallel-Script-Runner) for the scheduling model and hooks.
- [devutil CLI](devutil-CLI) for the full flag surface.
- [Development](Development) if you are working on this repo rather than consuming it.
