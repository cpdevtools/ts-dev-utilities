import { lstat, mkdir, readFile, readlink, realpath, rmdir, symlink, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import semverSatisfies from 'semver/functions/satisfies.js';
import { parseJson } from '../json/jsonc.js';
import type { DevLinkConfig, DevLinkOpResult, DevLinkPeerStatus } from './types.js';

/**
 * Peer satisfaction for dev-linked checkouts.
 *
 * Node resolves a package's own imports from its REAL path, so a dev-linked
 * checkout resolves its dependencies from its own `node_modules`, not the
 * consumer's. For an ordinary dependency that is correct. For a **peer
 * dependency** it is wrong by definition — a peer means "use the host's copy"
 * — and for anything that must be a single instance (a DI runtime, an
 * observable library) it yields two runtimes and a failure far from its cause
 * (Angular's NG0203 was the one that surfaced this).
 *
 * The fix is per peer, not per checkout: `<checkout>/node_modules/<peer>` is
 * made a symlink to the consumer's installed copy. The checkout's own
 * `node_modules` is otherwise untouched, so a source checkout keeps the dev
 * tooling it needs to build. Whatever was there before is recorded so unlink
 * can put it back; directories created along the way are recorded so unlink
 * can remove exactly those and nothing else.
 */

export interface PeerManifest {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  version?: string;
}

export interface PeerSpec {
  name: string;
  range?: string;
  optional: boolean;
}

/** Per-package peer record in the sidecar: original entry target (null = did not exist). */
export interface PeerSidecar {
  /** peer name -> original symlink target, or null when dev-link created the entry */
  entries: Record<string, string | null>;
  /** directories dev-link created inside the checkout, in creation order */
  created: string[];
}

/** Declared peers plus configured `shared` names, deduplicated. */
export function collectPeers(pkg: string, manifest: PeerManifest, config: DevLinkConfig): PeerSpec[] {
  const enabled = config.packageOptions?.[pkg]?.peers ?? config.peers ?? true;
  if (!enabled) return [];
  const specs = new Map<string, PeerSpec>();
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    specs.set(name, { name, range, optional: manifest.peerDependenciesMeta?.[name]?.optional === true });
  }
  for (const name of config.packageOptions?.[pkg]?.shared ?? []) {
    if (!specs.has(name)) specs.set(name, { name, optional: false });
  }
  return [...specs.values()];
}

function entryPath(base: string, name: string): string {
  return join(base, 'node_modules', ...name.split('/'));
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function readVersion(dir: string): Promise<string | undefined> {
  try {
    const m = parseJson(await readFile(join(dir, 'package.json'), 'utf-8')) as { version?: string };
    return m.version;
  } catch {
    return undefined;
  }
}

/** Create `dir` (and parents up to and including `<checkout>/node_modules`), recording what was created. */
async function ensureDir(dir: string, stopAt: string, record: PeerSidecar): Promise<void> {
  const missing: string[] = [];
  let cur = dir;
  while (true) {
    try {
      await lstat(cur);
      break;
    } catch {
      missing.unshift(cur);
      if (cur === stopAt) break;
      cur = dirname(cur);
    }
  }
  for (const m of missing) {
    await mkdir(m);
    if (!record.created.includes(m)) record.created.push(m);
  }
}

/**
 * Make every peer of the linked checkout resolve to the consumer's copy at
 * `root`. Idempotent; safe to re-run on an already-linked package (this is how
 * a `dist/` that a rebuild wiped gets its peer links back on the next `auto`).
 */
export async function linkPeers(
  root: string,
  pkg: string,
  location: string | undefined,
  checkoutReal: string,
  manifest: PeerManifest,
  config: DevLinkConfig,
  record: PeerSidecar,
): Promise<DevLinkOpResult[]> {
  const results: DevLinkOpResult[] = [];
  const label = location ? `${pkg} (${location})` : pkg;

  for (const spec of collectPeers(pkg, manifest, config)) {
    const hostEntry = entryPath(root, spec.name);
    const hostReal = await realpathOrNull(hostEntry);
    if (hostReal === null) {
      results.push({
        pkg,
        location,
        peer: spec.name,
        action: 'peer-missing',
        message: spec.optional
          ? `${label}: optional peer ${spec.name} is not installed here — left to the checkout's own copy`
          : `${label}: peer ${spec.name} is not installed here — the checkout will use its own copy (two instances)`,
      });
      continue;
    }

    const target = entryPath(checkoutReal, spec.name);
    let existing: string | null | undefined; // undefined = unknown yet
    try {
      const st = await lstat(target);
      if (!st.isSymbolicLink()) {
        results.push({
          pkg,
          location,
          peer: spec.name,
          action: 'peer-skipped',
          message: `${label}: ${spec.name} inside the checkout is a real directory — left alone (dev-link never replaces one)`,
        });
        continue;
      }
      if ((await realpathOrNull(target)) === hostReal) {
        continue; // already resolves to the consumer's copy
      }
      existing = await readlink(target);
    } catch {
      existing = null;
    }

    await ensureDir(dirname(target), join(checkoutReal, 'node_modules'), record);
    if (!(spec.name in record.entries)) record.entries[spec.name] = existing ?? null; // first-seen wins
    if (existing !== null) await unlink(target);
    await symlink(hostReal, target, 'dir');

    const hostVersion = await readVersion(hostReal);
    const satisfies = spec.range === undefined || hostVersion === undefined ? undefined : semverSatisfies(hostVersion, spec.range, { includePrerelease: true });
    results.push({
      pkg,
      location,
      peer: spec.name,
      action: satisfies === false ? 'peer-mismatch' : 'peer-linked',
      message:
        satisfies === false
          ? `${label}: ${spec.name} → consumer's ${hostVersion ?? '?'} (does not satisfy declared ${spec.range})`
          : `${label}: ${spec.name} → consumer's copy${hostVersion ? ` (${hostVersion})` : ''}`,
    });
  }
  return results;
}

/** Undo `linkPeers` using the sidecar record; removes only what dev-link created. */
export async function unlinkPeers(
  pkg: string,
  location: string | undefined,
  checkoutReal: string | null,
  record: PeerSidecar,
): Promise<DevLinkOpResult[]> {
  const results: DevLinkOpResult[] = [];
  const label = location ? `${pkg} (${location})` : pkg;
  if (checkoutReal !== null) {
    for (const [peer, original] of Object.entries(record.entries)) {
      const target = entryPath(checkoutReal, peer);
      try {
        const st = await lstat(target);
        if (!st.isSymbolicLink()) continue; // never touch a real directory
        await unlink(target);
      } catch {
        continue;
      }
      if (original !== null) await symlink(original, target, 'dir');
      results.push({
        pkg,
        location,
        peer,
        action: 'peer-restored',
        message: original !== null ? `${label}: ${peer} restored → ${original}` : `${label}: ${peer} link removed`,
      });
    }
    for (const dir of [...record.created].reverse()) {
      try {
        await rmdir(dir); // only succeeds when empty — anything else in there is not ours
      } catch {
        // not empty or already gone
      }
    }
  }
  record.entries = {};
  record.created = [];
  return results;
}

/** Status of each peer for a linked checkout, by stat-ing real targets. */
export async function peerStatus(
  root: string,
  pkg: string,
  checkoutReal: string,
  manifest: PeerManifest,
  config: DevLinkConfig,
): Promise<DevLinkPeerStatus[]> {
  const out: DevLinkPeerStatus[] = [];
  for (const spec of collectPeers(pkg, manifest, config)) {
    const hostReal = await realpathOrNull(entryPath(root, spec.name));
    const entry: DevLinkPeerStatus = { peer: spec.name, state: 'not-linked' };
    if (spec.range !== undefined) entry.range = spec.range;
    if (hostReal === null) {
      entry.state = spec.optional ? 'optional-missing' : 'missing';
    } else {
      const hostVersion = await readVersion(hostReal);
      if (hostVersion !== undefined) {
        entry.hostVersion = hostVersion;
        if (spec.range !== undefined) entry.satisfies = semverSatisfies(hostVersion, spec.range, { includePrerelease: true });
      }
      const checkoutReal2 = await realpathOrNull(entryPath(checkoutReal, spec.name));
      entry.state = checkoutReal2 === hostReal ? 'linked' : 'not-linked';
    }
    out.push(entry);
  }
  return out;
}

/** Resolve a path inside the checkout without following the final component. */
export function checkoutEntry(checkoutReal: string, name: string): string {
  return resolve(entryPath(checkoutReal, name));
}
