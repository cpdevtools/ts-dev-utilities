# Dependency Versions

One file declares the version a dependency should have; the engine finds every place that
dependency is written across the repo and reports or rewrites it. It covers four ecosystems that
each have their own syntax for the same idea — npm manifests, .NET project files, Docker image
tags, and GitHub Actions `uses:` pins.

```bash
devutil dep-versions check .publish/deps.yml   # report drift, exit 1 if any
devutil dep-versions fix   .publish/deps.yml   # rewrite files
```

```ts
import { checkDepVersions, fixDepVersions } from '@cpdevtools/ts-dev-utilities/dep-versions';

const drift = await checkDepVersions('.publish/deps.yml', process.cwd());
const applied = await fixDepVersions('.publish/deps.yml', process.cwd());
```

## The deps file

A YAML map of section → `{ name: version }`. Section names must match a registered handler; an
unrecognised section is skipped with a warning rather than failing the run.

```yaml
npm:
  '@cpdevtools/git-flow': '1.0.0-rc.0'
  typescript: '^5.7.3'
  vitest: '^2.1.8'

dotnet:
  IdealSupply.Api: '1.0.2'

docker:
  node: '24-alpine'
  'mcr.microsoft.com/dotnet/aspnet': '10.0'

github-actions:
  actions/checkout: 'v7'
```

An empty or non-object file is an error. Everything is matched by **exact name**; there is no glob
or prefix matching.

## What each handler touches

| Section          | Files scanned                                                                    | What is rewritten                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm`            | Every discovered `package.json` **plus the workspace root**, and all Dockerfiles | `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`; annotated `ARG`s and literal `name@version` install sites in Dockerfiles |
| `dotnet`         | `**/Directory.Packages.props`, `**/*.csproj`                                     | `Version="…"` on `<PackageVersion>` / `<PackageReference>` with a matching `Include`                                                                    |
| `docker`         | Dockerfiles (all spellings), `docker-compose*.yml` / `.yaml`                     | The tag in `FROM image:tag` and `image: image:tag`                                                                                                      |
| `github-actions` | `.github/workflows/**/*.yml`/`.yaml`, `**/action.yml`/`.yaml`                    | The ref in `uses: owner/repo@ref`                                                                                                                       |

`node_modules`, `dist`, `.pnpm-prod` (and `bin`/`obj` for .NET) are ignored, and no handler follows
symlinks.

## Rules that keep it safe

The handlers deliberately refuse to touch things that look like versions but are not pins. Each of
these exists because overwriting them causes a real defect:

**npm — specifiers carrying a protocol are never rewritten.** `workspace:`, `link:`, `file:`,
`portal:`, `catalog:`, `npm:` aliases, git and tarball URLs all say _where_ a dependency comes from,
not which version to take. Replacing `workspace:*` in particular swaps a live workspace link for a
published package, so a package silently builds against its last release instead of the sibling
source. (A plain semver range never contains a colon, which is how they are told apart.)

**npm — the workspace root is scanned even though it is not a project.** `discoverProjects`
excludes the root by design, but the root is where shared tooling devDependencies live, so the
handler adds it back. Without that, the whole toolchain would sit unpinned.

**docker — interpolated tags are left alone.** A tag starting with `$` is supplied at build or
deploy time. A deploy bundle's `image: repo:${DEPLOY_IMAGE_TAG}` is the released version, not a
pin; baking a literal over it ships the wrong image.

**Both Dockerfile spellings are matched.** globby is case-sensitive on Linux, so `Dockerfile`,
`dockerfile`, `*.dockerfile` and the `.suffix` forms are all listed explicitly. A repo using the
lowercase spelling was once invisible to the handler entirely.

## npm versions inside Dockerfiles

The same package pinned in `package.json` is often also pinned in an image build. Those belong to
the `npm` handler (the `docker` handler is only concerned with image tags), and two shapes are
recognised.

**Annotated build args.** Nothing in `ARG NAME=value` names the package, and guessing from the arg
name would be wrong as often as right — so the annotation is required:

```dockerfile
# dep-version: @cpdevtools/git-flow-deploy-cli
ARG DEPLOY_CLI_VERSION=1.0.0-rc.0
RUN npm install -g "@cpdevtools/git-flow-deploy-cli@${DEPLOY_CLI_VERSION}"
```

The annotation must be on the line immediately above the `ARG`. An `ARG` whose value contains `${`
is skipped — it is set elsewhere and rewriting it would break the build.

**Literal install sites.** `name@version` anywhere in the file is rewritten directly:

```dockerfile
RUN npm install -g @cpdevtools/ts-dev-utilities-cli@0.4.1
```

A `name@$…` reference is skipped for the same reason as above.

## Results

Both functions resolve to `DepChange[]`:

```ts
interface DepChange {
  file: string; // absolute path
  name: string; // package / image / action name
  from: string; // what was there
  to: string; // the target from the deps file
}
```

`check` never writes; `fix` writes and returns what it changed. An empty array means everything is
already at target.

## Custom handlers

The registry is extensible — register a handler and its section name becomes valid in the deps
file:

```ts
import { registerHandler } from '@cpdevtools/ts-dev-utilities/dep-versions';
import type { DepVersionHandler } from '@cpdevtools/ts-dev-utilities/dep-versions';

const helmHandler: DepVersionHandler = {
  name: 'helm',
  check: (cwd, deps) => scanCharts(cwd, deps, false),
  fix: (cwd, deps) => scanCharts(cwd, deps, true),
};

registerHandler(helmHandler);
```

`registerHandler` mutates the shared `defaultRegistry`. For isolation — tests, or two different
rule sets in one process — build your own:

```ts
import { HandlerRegistry, checkDepVersions } from '@cpdevtools/ts-dev-utilities/dep-versions';

const registry = new HandlerRegistry().register(helmHandler);
await checkDepVersions('deps.yml', process.cwd(), registry);
```

`check` and `fix` receive `(cwd, deps)` and must return one `DepChange` per site found — `check`
reporting without writing, `fix` writing and reporting. Registration is by `handler.name`, so
re-registering the same name replaces the previous handler.

## Wiring it in

The convention in these repos is a `.publish/deps.yml` at the root, with a wireit task on each
side:

```json
{
  "wireit": {
    "check.deps": { "command": "devutil dep-versions check .publish/deps.yml" },
    "fix.deps": { "command": "devutil dep-versions fix .publish/deps.yml" }
  }
}
```

`check.deps` hangs off the repo's `check` task (so CI fails on drift) and `fix.deps` runs before
syncpack in `fix`, so `pnpm fix` pins first and reconciles ranges after.

Source:
[`src/dep-versions/`](https://github.com/cpdevtools/ts-dev-utilities/tree/main/packages/ts-dev-utilities/src/dep-versions)
