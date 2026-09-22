# Dev-Link

Developing against local checkouts of `@cpdevtools/*` packages is done with **`devutil dev-link`**,
not by changing pnpm's resolution. `pnpm install` always installs the published graph from the
single committed lockfile; `dev-link` then repoints the installed `node_modules/@cpdevtools/<pkg>`
symlinks at sibling checkouts listed in `.publish/dev-local.yml`. The lockfile and manifests never
change, pnpm's install fingerprint never stats symlink targets, and `.bin` shims follow the repoint
— so the overlay is invisible to pnpm and survives everything short of a real install (which
`postinstall: devutil dev-link auto` self-heals).

```bash
devutil dev-link status [pkg...] [--check]   # one row per install location; --check exits 1 unless all linked
devutil dev-link link   [pkg...]             # repoint at local checkouts (refuses under CI)
devutil dev-link unlink [pkg...]             # restore the pnpm-installed symlinks
devutil dev-link auto                        # postinstall hook — DEV_LOCAL=true only, never CI, always exit 0
```

```ts
import {
  loadDevLinkConfig,
  linkPackages,
  getDevLinkStatus,
} from '@cpdevtools/ts-dev-utilities/dev-link';

const config = await loadDevLinkConfig(process.cwd()); // null when nothing is mapped
if (config) {
  const results = await linkPackages(config, { cwd: process.cwd() });
  const report = await getDevLinkStatus(config, { cwd: process.cwd() });
}
```

## Why not a pnpmfile

The previous mechanism was a `.pnpmfile.cjs` that rewrote `@cpdevtools/*` dependencies to `file:`
paths under `DEV_LOCAL=true`. Because that mutated resolution — which pnpm 11 records in the
lockfile and frozen-validates — it required a second committed lockfile (`.pnpm-prod/`), pre-commit
lockfile surgery, and fingerprint deletion. dev-link replaced all of that on 2026-08-31: it works
_after_ install, on the symlinks pnpm has already written, so there is nothing for pnpm to record
and nothing to reconcile. The actions still auto-detect which layout a repo uses by the presence of
`.pnpm-prod/pnpm-lock.yaml`.

## The map file

`.publish/dev-local.yml` (override with `--config <path>`) maps package name → path of the local
checkout's **package directory**, relative to the workspace root:

```yaml
packages:
  '@cpdevtools/git-flow': '../git-flow/packages/git-flow'
  '@cpdevtools/git-flow-cli': '../git-flow/packages/cli'
```

A missing file, or one that maps no packages, is "nothing configured" — a normal state, not an
error. Every command prints a one-line notice and exits 0. A path that is not a non-empty string is
an error.

An entry may also be an object, when a package needs peer options (see
[Peer dependencies](#peer-dependencies)):

```yaml
peers: true # default; false turns peer linking off for every package
packages:
  '@cpdevtools/git-flow': '../git-flow/packages/git-flow'
  '@idealsupply/ng-client':
    path: '../webservice/.clients/ng/dist'
    shared: ['rxjs'] # dependencies to treat like declared peers
  '@org/tooling':
    path: '../tooling'
    peers: false # this checkout keeps its own copies
```

Positional `[pkg...]` arguments restrict a command to those packages; a name that is not in the
map is an error listing the packages that are.

## How linking works

`link` walks each mapped package and, wherever it is installed, replaces the `node_modules/<pkg>`
symlink with one pointing at the checkout. Three rules bound what it touches:

- **Only symlinks.** A `node_modules` entry that is a real directory is never replaced — it is
  reported as `skipped` by `link`, `noop` by `unlink`, and `not-symlink` by `status`.
- **Only installed packages.** A mapped package with no `node_modules` entry anywhere is
  `skipped`; dev-link never creates entries pnpm did not.
- **Never under CI.** `link` throws (and so exits 1) when `GITHUB_ACTIONS=true` or `CI` is set to
  anything other than empty, `false` or `0`. The overlay is a local-dev mechanism.

### Install roots

In a pnpm workspace, a mapped package can be installed in **member projects' own `node_modules`**
too, and that nested entry is the one Node resolves for the member's code — it shadows the root
entry. dev-link therefore operates on every install root — the workspace root plus each member
project discovered from `pnpm-workspace.yaml` — linking wherever the package is actually
installed. `status` shows one row per location, labelled `pkg (packages/member)` for nested
entries. pnpm rewrites member `node_modules` even on an "Already up to date" install, so nested
links are reset more often than root ones; the postinstall auto-relink heals both, provided the
installed CLI is new enough to know about nested roots (≥ 1.1.4).

Without a `pnpm-workspace.yaml` only the root is considered — discovery's non-workspace fallback
is far too broad for overlay purposes.

### The built-ness check

Linking an unbuilt checkout would make every consumer fail with a missing `dist/`, so `link`
checks first that the files a consumer will actually load exist: **every `bin` value, every string
leaf of `exports`** (ignoring `types` and `source` conditions, and patterns containing `*`), and
**`publishConfig.main`** — falling back to plain `main` only when the manifest has no `exports`
map. A checkout missing any of them is `refused` with the list of missing files and a hint to run
`pnpm build` there. `status` reports the same condition as `not-built`.

### The sidecar

Before repointing a symlink whose target is in the pnpm store (`node_modules/.pnpm/…`), `link`
records the original relative target in **`node_modules/.dev-link.json`** in that install root
(first-seen wins — an existing record is never overwritten). It lives in `node_modules`, so it is
never committed and disappears with it. The file is removed when its last record is.

The file is `{ "version": 2, "targets": { pkg: originalTarget }, "peers": { pkg: { entries, created } } }`.
`targets` is what version 1 held as a flat map (a v1 file is still read); `peers` records, per
linked package, each peer entry's original target inside the checkout (`null` when dev-link created
it) and the directories dev-link created there, so `unlink` can remove exactly those.

`unlink` uses the record to restore the original symlink **byte-identically**. If the recorded
target no longer resolves (the store was pruned), the link is removed and the result is `removed`
— a `pnpm install` is needed to get the published package back.

`status` never trusts the sidecar for state; it stats the real symlink targets. The sidecar is
consulted only to detect **links reset by an install**: a package with a record whose entry now
points at the store means a real `pnpm install` has undone the overlay since the last link.

## Commands and exit codes

| Subcommand         | What it does                                                                                | Exits 1 when                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `status [--check]` | One row per package per install location, derived from the real symlink targets.            | Only with `--check`: any entry is `published` or `not-symlink`, any link was reset by an install, or a linked checkout has a required peer that is `missing` or `not-linked`. |
| `link`             | Repoint installed entries at the checkouts, recording originals in the sidecar, then link each checkout's peers to this repo's copies. | Any result is `refused` (unbuilt checkout). Running under CI is an error.                            |
| `unlink`           | Restore the original store symlinks from the sidecar.                                       | Any result is `removed` (original target gone — run `pnpm install`).                                 |
| `auto`             | `link` everything mapped, but only when `DEV_LOCAL=true` and not CI; problems are warnings. | Never.                                                                                               |

`status` output, one row per entry:

```
@cpdevtools/git-flow                     LINKED → ../git-flow/packages/git-flow (1.0.6)
@idealsupply/ng-client                   LINKED → ../webservice/.clients/ng/dist (2.3.0-dev.4); peers: 3 linked, 1 optional-missing (@angular/forms)
@cpdevtools/git-flow (packages/cli)      published (1.0.5) — checkout not built (run pnpm build in ../git-flow/packages/git-flow)
@cpdevtools/ts-dev-utilities             published (1.1.9) — checkout missing at ../ts-dev-utilities/packages/ts-dev-utilities

A pnpm install has reset these links — rerun 'devutil dev-link link':
  @cpdevtools/ts-dev-utilities
```

`link` and `unlink` print one line per result. The actions:

| Action           | Command | Meaning                                                          |
| ---------------- | ------- | ---------------------------------------------------------------- |
| `linked`         | link    | Repointed; the message shows the local and previous versions.    |
| `already-linked` | link    | Already resolves to the checkout.                                |
| `skipped`        | link    | Not installed, checkout missing, or a real directory.            |
| `refused`        | link    | Checkout exists but is not built.                                |
| `restored`       | unlink  | Original store symlink restored byte-identically.                |
| `removed`        | unlink  | Link removed but no restorable original — `pnpm install` needed. |
| `noop`           | unlink  | Not installed, already published, or a real directory.           |
| `peer-linked`    | link    | A peer inside the checkout now resolves to this repo's copy.     |
| `peer-mismatch`  | link    | Linked, but this repo's version is outside the declared range.   |
| `peer-missing`   | link    | This repo has no copy of a peer the checkout declares.           |
| `peer-skipped`   | link    | The checkout's own entry for the peer is a real directory.       |
| `peer-restored`  | unlink  | The checkout's original peer entry put back, or ours removed.    |

## Layered, not transitive

The overlay is **layered, not transitive**: a repo that links a local `git-flow` gets that
checkout's own `node_modules` — including its published `ts-dev-utilities` — unless the git-flow
checkout is itself dev-linked. Each repo controls only its own overlay. Ordinary dependencies of a
linked checkout come from the checkout, exactly as classic `npm link` behaves. Peer dependencies
are the exception, and are handled below.

## Peer dependencies

Node resolves a package's imports from its **real** path. A dev-linked checkout therefore resolves
everything it imports from its own `node_modules`, not the consumer's. For ordinary dependencies
that is correct. For a **peer dependency** it is wrong by definition — a peer means "use the host's
copy" — and for anything that must be a single instance (a DI runtime such as `@angular/core`, an
observable library such as `rxjs`) it yields two runtimes and a failure far from its cause
(Angular's `NG0203` "inject() must be called from an injection context" is the classic symptom).

So `link` makes each declared peer of the checkout resolve to the consumer's installed copy: for
every `peerDependencies` entry that the consumer has installed, `<checkout>/node_modules/<peer>`
becomes a symlink to the consumer's copy. Nothing else in the checkout's `node_modules` is touched,
so a source checkout keeps the dev tooling it needs to build. Whatever the entry was before is
recorded in the sidecar and put back by `unlink`; directories created on the way (often the
checkout's whole `node_modules`, for a `dist/` checkout) are removed again if empty.

- A peer the consumer does **not** have is reported (`peer-missing`) and left alone; the checkout
  keeps using its own copy. `status --check` fails for a required peer in that state, and passes for
  one declared optional in `peerDependenciesMeta`.
- If the consumer's version does not satisfy the declared range, the peer is still linked (the
  host's version is the one the app is running) and the result is `peer-mismatch`.
- A real directory inside the checkout is never replaced (`peer-skipped`), the same rule as for the
  package entry itself.
- `link` re-checks peers on an already-linked package, so a rebuild that wiped the checkout's
  `dist/` — and the peer links inside it — is healed by the next `link` or `auto`.

`shared: [...]` in the map lists dependencies to treat like declared peers — for a checkout that
declares a must-be-single-instance library under `dependencies`. The principled fix is to declare
it as a peer in that package; `shared` is the escape hatch until then. `peers: false`, globally or
per package, turns the behaviour off.

## Wiring a consumer repo

Two pieces, both in the consumer:

```json
{
  "scripts": {
    "postinstall": "devutil dev-link auto"
  }
}
```

and `DEV_LOCAL=true` exported ambiently in the development environment (the devcontainer does
this). `auto` is gated on that variable and on not being under CI, so the same `postinstall` is
a no-op in CI and on a machine without the variable — and it always exits 0, because a postinstall
must never fail an install. `pnpm install` therefore installs the published graph and immediately
re-applies the overlay.

In this repo the map is **empty** (no `.publish/dev-local.yml`): the two workspace packages already
resolve each other via `workspace:*`. Consumer repos (git-flow, the webservice repos) carry a map
and the `postinstall` hook.

## Library API

Everything the CLI does is available from `@cpdevtools/ts-dev-utilities/dev-link`:

| Export                | Kind     | Signature / type                                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_CONFIG_PATH` | const    | `'.publish/dev-local.yml'`                                                                                                |
| `loadDevLinkConfig`   | function | `(cwd: string, configPath?: string) => Promise<DevLinkConfig \| null>` — `null` when the file is absent or maps nothing   |
| `linkPackages`        | function | `(config: DevLinkConfig, options?: DevLinkOptions) => Promise<DevLinkOpResult[]>` — throws under CI                       |
| `unlinkPackages`      | function | `(config: DevLinkConfig, options?: DevLinkOptions) => Promise<DevLinkOpResult[]>`                                         |
| `getDevLinkStatus`    | function | `(config: DevLinkConfig, options?: DevLinkOptions) => Promise<DevLinkStatusReport>`                                       |
| `autoLink`            | function | `(options?: DevLinkOptions & { configPath?: string }) => Promise<AutoLinkResult>` — `ran: false` when a guard stopped it  |
| `isCIEnvironment`     | function | `() => boolean` — same CI detection as the CLI                                                                            |
| `collectPeers`        | function | `(pkg: string, manifest: PeerManifest, config: DevLinkConfig) => PeerSpec[]` — declared peers plus `shared` names       |
| `DevLinkConfig`       | type     | `{ packages: Record<string, string>; peers?: boolean; packageOptions?: Record<string, DevLinkPackageOptions> }`           |
| `DevLinkPackageOptions` | type   | `peers?: boolean`, `shared?: string[]`                                                                                    |
| `DevLinkOptions`      | type     | `cwd?` (default `process.cwd()`), `packages?` (restrict to these mapped names)                                            |
| `DevLinkOpResult`     | type     | `pkg`, `location?`, `action: DevLinkAction`, `message`, `peer?` (for the `peer-*` actions)                                |
| `DevLinkAction`       | type     | `'linked' \| 'already-linked' \| 'skipped' \| 'refused' \| 'restored' \| 'removed' \| 'noop' \| 'peer-linked' \| 'peer-mismatch' \| 'peer-missing' \| 'peer-skipped' \| 'peer-restored'` |
| `DevLinkStatusReport` | type     | `entries: DevLinkStatusEntry[]`, `resetByInstall: string[]`                                                               |
| `DevLinkStatusEntry`  | type     | `pkg`, `location?`, `localPath`, `install: InstallState`, `checkout: CheckoutState`, `installedVersion?`, `localVersion?`, `peers?: DevLinkPeerStatus[]` (linked entries only) |
| `DevLinkPeerStatus`   | type     | `peer`, `state: PeerState`, `range?`, `hostVersion?`, `satisfies?`                                                       |
| `PeerState`           | type     | `'linked' \| 'not-linked' \| 'missing' \| 'optional-missing'`                                                            |
| `InstallState`        | type     | `'linked' \| 'published' \| 'not-installed' \| 'not-symlink'`                                                             |
| `CheckoutState`       | type     | `'ready' \| 'missing' \| 'not-built'`                                                                                     |
| `AutoLinkResult`      | type     | `ran: boolean`, `results: DevLinkOpResult[]`                                                                              |

`location` is the workspace-relative directory of a member project's install root and is omitted
for the workspace root. Exit-code policy is the caller's: the engine only reports actions, and the
CLI maps `refused` / `removed` / unlinked-with-`--check` to exit 1 as described above.

Source:
[`src/dev-link/`](https://github.com/cpdevtools/ts-dev-utilities/tree/main/packages/ts-dev-utilities/src/dev-link)
