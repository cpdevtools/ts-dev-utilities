# Releasing

This repo releases itself with [git-flow](https://github.com/cpdevtools/git-flow). Nothing is
published by hand, and no version number is typed into a `package.json`.

## The placeholder

Every manifest carries `"version": "0.0.0-MAIN"`. The real version lives in
`.publish/versions.yml`:

```yaml
0.0.0-MAIN: 0.4.1-rc.4
```

That file is **branch-specific**, which is what lets a `v1` maintenance branch and `main` share the
same `MAIN` key while resolving to different tracks. `gitflow apply-version` substitutes the real
version at build time; the placeholder is what is committed.

## Cutting a release

```bash
pnpm gitflow version    # or: npx gitflow version
```

The CLI shows the current resolved version and offers the legal next steps — finish the
pre-release, advance within the channel, change channel, or start the next patch/minor/major at
`-dev.0`. It will never offer a version whose tag already exists. It writes `.publish/versions.yml`
and commits.

Then just push:

```bash
git push
```

## What the workflows do

| Workflow                 | Trigger                                | Action                                                                                                                 |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `create-release-pr.yml`  | push to any branch except `release/**` | Ensures `release/<branch>` exists and keeps a draft release PR up to date with resolved versions and artifact metadata |
| `test.yml`               | push to any branch except `release/**` | git-flow's `test` action, `mode: test-optional`                                                                        |
| `build-pack-publish.yml` | a PR **merged** into `release/**`      | `build-pack` then `publish-release`                                                                                    |
| `cleanup-scheduled.yml`  | daily at 02:00 UTC, or manual          | Prunes superseded prerelease builds (`dry_run` defaults to `true` on manual runs)                                      |

**Merging the draft release PR is what publishes.** Up to that point every push just keeps the PR
current. After the merge, `build-pack` builds and packs from the PR's metadata and uploads to the
draft Release; `publish-release` pushes to the registries, creates the tags, and finalises the
Release.

## Registries

`.publish/registries.yml` names the targets that `release-artifacts.yml` files refer to by ID:

```yaml
registries:
  github-npm:
    type: npm
    url: https://npm.pkg.github.com
    auth: GITHUB_TOKEN
    scope: '@cpdevtools'
```

Both packages declare the same single artifact:

```yaml
artifacts:
  - type: npm
    name: '${PACKAGE_NAME}'
    path: '${TARBALL_PATH}'
    registries:
      - github-npm
```

See [Artifacts](Artifacts) for the full type list and for the `docker` → `docker-image` rename.

## Consuming a release the day it publishes

`ts-dev-utilities` and `git-flow` move in lockstep, so both repos exclude the three packages
involved from pnpm's minimum-release-age check in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - '@cpdevtools/git-flow'
  - '@cpdevtools/git-flow-cli'
  - '@cpdevtools/ts-dev-utilities'
```

Entries must be **bare package names**. pnpm stops at the first entry matching a package, so a
`name@version` pin shadows every later entry for that package, silently — it surfaces as CI failing
on a release that was explicitly meant to be allowed.

## Checklist before merging a release PR

- `pnpm check` is clean — no dependency drift, no syncpack mismatches.
- `pnpm test` and `pnpm typecheck` pass locally, and `test.yml` is green on the branch.
- If a subpath export was added, `package.json` `exports` and `tsup.config.ts` both list it —
  see [Development](Development).
- If a published type changed shape, [API Reference](API-Reference) matches reality.
