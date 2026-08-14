# Artifacts

An **artifact descriptor** is the handoff between a project's pack script and git-flow's release
pipeline. The project declares what it produced; `build-pack` collects the descriptors, uploads the
files to the draft GitHub Release, and `publish-release` pushes them to registries.

This module is the shared vocabulary — the types and the writer. The pipeline that consumes them
lives in [git-flow](https://github.com/cpdevtools/git-flow).

```ts
import { writeArtifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import type { Artifact, ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
```

## `writeArtifact(descriptor)`

Writes `{PROJECT_NAME}.artifact.yml` into the artifact output directory.

```ts
await writeArtifact({
  project: '@myorg/my-package',
  artifacts: [
    {
      type: 'npm',
      name: '@myorg/my-package',
      path: 'dist/myorg-my-package-1.2.3.tgz',
      registries: ['github-npm'],
    },
  ],
});
```

It reads two environment variables, both set by the workflow, and **throws if either is missing**:

| Variable              | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `ARTIFACT_OUTPUT_DIR` | Directory the descriptor is written to. Created if absent. |
| `PROJECT_NAME`        | Becomes the descriptor filename.                           |

Call it from the project's `github.actions.pack` script, after the packing itself has produced the
files.

## Artifact types

```ts
interface ProjectArtifactDescriptor {
  project: string;
  artifacts: Artifact[];
}
```

### `npm`

| Field         | Notes                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `name`        | Package name, e.g. `@myorg/pkg`                                                                   |
| `path?`       | Path to the `.tgz`. Populated by `gitflow pack` — omit when declaring in `release-artifacts.yml`. |
| `registries?` | Registry IDs from `.publish/registries.yml`                                                       |

### `docker-image`

> ⚠️ **This type was previously `docker`.** The plugin-system work renamed it. A repo bumping
> git-flow past that change must rename `type: docker` → `type: docker-image` in its
> `release-artifacts.yml` in the same commit, or build-pack fails with
> `Unknown artifact type: 'docker'`.

| Field                                                    | Notes                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `name`                                                   | Full image name including registry, e.g. `ghcr.io/owner/image` |
| `localTag?`                                              | Local tag to push. Defaults to `name:latest`.                  |
| `tempTag?` `finalTag?` `digest?` `registry?` `pushedAt?` | All populated by `gitflow pack` — do not set by hand.          |
| `registries?`                                            | Registry IDs                                                   |

### `nuget`

| Field         | Notes                                              |
| ------------- | -------------------------------------------------- |
| `name`        | Package name                                       |
| `path`        | Path to the `.nupkg`, relative to the project root |
| `registries?` | Registry IDs                                       |

### `release-attachment`

Arbitrary files attached to the GitHub Release.

| Field         | Notes                           |
| ------------- | ------------------------------- |
| `name`        | Display name                    |
| `path`        | Relative to the project root    |
| `contentType` | e.g. `application/octet-stream` |

### `deploy`

A zip bundle produced by `gitflow pack-deploy` and uploaded to the draft release for a deploy
gateway to fetch.

| Field   | Notes                                                                                   |
| ------- | --------------------------------------------------------------------------------------- |
| `name`  | **Unique within the project.** Drives every generated name. Typically the package name. |
| `path?` | Absolute path to the produced zip — populated by `gitflow pack-deploy`.                 |

`name` determines:

```
DEPLOY_OUTPUT_DIR = <projectCwd>/.deploy-output/<safeName(name)>
zip               = ARTIFACT_OUTPUT_DIR/<safeName(name)>-deploy.zip
```

A project may declare several deploy artifacts (separate staging/prod bundles, say) as long as each
name is distinct.

### Custom / plugin types

Any `type` string that is not built in is a `CustomArtifact`: `type`, `name`, an optional `path`,
and any additional plugin-specific fields. The plugin package must register a handler with
git-flow's `registerArtifactType` before an artifact of that type is dispatched, otherwise packing
fails with `Unknown artifact type`.

## Declaring vs producing

Two files with similar content, different roles:

- **`release-artifacts.yml`** (committed, per publishable project) declares what the project
  _will_ produce. Values may be templated:

  ```yaml
  artifacts:
    - type: npm
      name: '${PACKAGE_NAME}'
      path: '${TARBALL_PATH}'
      registries:
        - github-npm
  ```

- **`{PROJECT_NAME}.artifact.yml`** (generated at pack time by `writeArtifact`) records what was
  _actually_ produced, with paths, tags and digests filled in.

Fields marked "populated by `gitflow pack`" are exactly the ones that only exist in the second
file.

Source:
[`src/artifacts/types.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/artifacts/types.ts) ·
[`src/artifacts/writeArtifact.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/artifacts/writeArtifact.ts)
