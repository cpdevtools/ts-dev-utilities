import { lstat, readFile, readlink, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseJson } from '../json/jsonc.js';
import { discoverProjects } from '../project/discover.js';
import { loadDevLinkConfig } from './config.js';
import type {
  CheckoutState,
  DevLinkConfig,
  DevLinkOpResult,
  DevLinkStatusEntry,
  DevLinkStatusReport,
  InstallState,
} from './types.js';

export interface DevLinkOptions {
  /** Workspace root (default: process.cwd()). */
  cwd?: string;
  /** Restrict the operation to these packages (must exist in the config map). */
  packages?: string[];
}

/**
 * Sidecar recording, per linked package, the original relative symlink target
 * the pnpm-installed entry had — so unlink can restore it byte-identically.
 * Lives in node_modules (never committed, wiped with it).
 */
const SIDECAR_FILE = '.dev-link.json';

interface PackageManifest {
  version?: string;
  main?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  publishConfig?: { main?: string };
}

/** CI detection matching the CLI's semantics (CI set and not ''/'false'/'0'). */
export function isCIEnvironment(): boolean {
  if (process.env.GITHUB_ACTIONS === 'true') return true;
  const ci = process.env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

// ----------------------------------------------------------------
// Internals
// ----------------------------------------------------------------

function nmPath(cwd: string, pkg: string): string {
  return join(cwd, 'node_modules', ...pkg.split('/'));
}

/**
 * Every directory whose `node_modules` can hold an installed entry for a mapped
 * package: the workspace root plus, in a pnpm workspace, each member project —
 * pnpm gives every member its own `node_modules`, and Node resolves a project's
 * deps from that nested entry, which shadows the root one. Only consulted when
 * `pnpm-workspace.yaml` exists; discovery's non-workspace fallback (a recursive
 * package.json glob) is far too broad for overlay purposes.
 */
async function getInstallRoots(cwd: string): Promise<string[]> {
  const roots = [resolve(cwd)];
  try {
    await stat(join(cwd, 'pnpm-workspace.yaml'));
  } catch {
    return roots;
  }
  try {
    for (const project of await discoverProjects({ cwd })) {
      const dir = resolve(project.directory);
      if (!roots.includes(dir)) roots.push(dir);
    }
  } catch {
    // Discovery failure never blocks the overlay — fall back to the root alone.
  }
  return roots;
}

/** Display label for an entry: bare pkg at the root, pkg (dir) in a member. */
function pkgLabel(pkg: string, location: string | undefined): string {
  return location ? `${pkg} (${location})` : pkg;
}

async function readSidecar(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(cwd, 'node_modules', SIDECAR_FILE), 'utf-8');
    const parsed = parseJson(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeSidecar(cwd: string, entries: Record<string, string>): Promise<void> {
  const file = join(cwd, 'node_modules', SIDECAR_FILE);
  if (Object.keys(entries).length === 0) {
    await rm(file, { force: true });
  } else {
    await writeFile(file, JSON.stringify(entries, null, 2) + '\n');
  }
}

async function readManifest(dir: string): Promise<PackageManifest | null> {
  try {
    return parseJson(await readFile(join(dir, 'package.json'), 'utf-8')) as PackageManifest;
  } catch {
    return null;
  }
}

/**
 * The artifact files a consumer will actually load from the package: every bin
 * value, every string leaf of `exports` (ignoring `types`/`source` conditions),
 * and `publishConfig.main` — falling back to `main` only when the manifest has
 * no `exports` map (with `exports`, `main` is dead weight Node ignores).
 */
function requiredArtifacts(manifest: PackageManifest): string[] {
  const files = new Set<string>();

  if (typeof manifest.bin === 'string') {
    files.add(manifest.bin);
  } else if (manifest.bin && typeof manifest.bin === 'object') {
    for (const value of Object.values(manifest.bin)) {
      if (typeof value === 'string') files.add(value);
    }
  }

  const collectLeaves = (node: unknown): void => {
    if (typeof node === 'string') {
      if (!node.includes('*')) files.add(node);
      return;
    }
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'types' || key === 'source') continue;
        collectLeaves(value);
      }
    }
  };
  if (manifest.exports !== undefined) collectLeaves(manifest.exports);

  if (typeof manifest.publishConfig?.main === 'string') {
    files.add(manifest.publishConfig.main);
  } else if (manifest.exports === undefined && typeof manifest.main === 'string') {
    files.add(manifest.main);
  }

  return [...files];
}

async function missingArtifacts(localDir: string, manifest: PackageManifest): Promise<string[]> {
  const missing: string[] = [];
  for (const rel of requiredArtifacts(manifest)) {
    try {
      await stat(resolve(localDir, rel));
    } catch {
      missing.push(rel);
    }
  }
  return missing;
}

function isStoreTarget(nm: string, target: string): boolean {
  const targetAbs = resolve(dirname(nm), target);
  return targetAbs.includes(`${sep}node_modules${sep}.pnpm${sep}`);
}

/** Resolves which packages an operation applies to, validating explicit names. */
function selectPackages(config: DevLinkConfig, requested?: string[]): [string, string][] {
  if (!requested || requested.length === 0) return Object.entries(config.packages);
  const unknown = requested.filter((pkg) => !(pkg in config.packages));
  if (unknown.length > 0) {
    throw new Error(
      `Not in the dev-link map: ${unknown.join(', ')}\nMapped packages: ${Object.keys(config.packages).join(', ')}`,
    );
  }
  return requested.map((pkg) => [pkg, config.packages[pkg]]);
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------
// link
// ----------------------------------------------------------------

async function linkOne(
  root: string,
  cwd: string,
  pkg: string,
  relPath: string,
  sidecar: Record<string, string>,
  location: string | undefined,
): Promise<DevLinkOpResult> {
  const nm = nmPath(root, pkg);
  const label = pkgLabel(pkg, location);

  let entryStat;
  try {
    entryStat = await lstat(nm);
  } catch {
    return { pkg, location, action: 'skipped', message: `${label}: not installed — skipped` };
  }
  if (!entryStat.isSymbolicLink()) {
    return {
      pkg,
      location,
      action: 'skipped',
      message: `${label}: node_modules entry is a real directory — skipped (dev-link never replaces one)`,
    };
  }

  const localAbs = resolve(cwd, relPath);
  const localManifest = await readManifest(localAbs);
  if (!localManifest) {
    return { pkg, location, action: 'skipped', message: `${label}: checkout not found at ${relPath} — skipped` };
  }

  const missing = await missingArtifacts(localAbs, localManifest);
  if (missing.length > 0) {
    return {
      pkg,
      location,
      action: 'refused',
      message: `${label}: not built (missing ${missing.join(', ')}) — run pnpm build in ${relPath}`,
    };
  }

  const localReal = await realpathOrNull(localAbs);
  const currentReal = await realpathOrNull(nm);
  if (localReal !== null && currentReal === localReal) {
    return { pkg, location, action: 'already-linked', message: `${label}: already linked → ${relPath}` };
  }

  let previousVersion = '?';
  if (currentReal) {
    previousVersion = (await readManifest(currentReal))?.version ?? '?';
  }

  // Record the original store target so unlink can restore it byte-identically.
  // First-seen wins: never overwrite an existing record.
  const currentTarget = await readlink(nm);
  if (isStoreTarget(nm, currentTarget) && !(pkg in sidecar)) {
    sidecar[pkg] = currentTarget;
  }

  await unlink(nm);
  await symlink(localAbs, nm, 'dir');

  const localVersion = localManifest.version ?? '?';
  return {
    pkg,
    location,
    action: 'linked',
    message: `linked ${label} → ${relPath} (local ${localVersion}, was ${previousVersion})`,
  };
}

/**
 * Repoints installed `node_modules/<pkg>` symlinks at local checkouts — at the
 * workspace root and in every member project whose own `node_modules` holds
 * the package (the nested entry is the one Node actually resolves there).
 * Refuses to run under CI. Exit-code policy is the caller's: a 'refused'
 * result (unbuilt checkout) is the only failure state.
 */
export async function linkPackages(
  config: DevLinkConfig,
  options: DevLinkOptions = {},
): Promise<DevLinkOpResult[]> {
  if (isCIEnvironment()) {
    throw new Error('dev-link: refusing to link under CI — the overlay is a local-dev mechanism');
  }
  const cwd = options.cwd ?? process.cwd();
  const selected = selectPackages(config, options.packages);
  const roots = await getInstallRoots(cwd);
  const sidecars = new Map<string, Record<string, string>>();

  const results: DevLinkOpResult[] = [];
  for (const [pkg, relPath] of selected) {
    const installedRoots: string[] = [];
    for (const root of roots) {
      try {
        await lstat(nmPath(root, pkg));
        installedRoots.push(root);
      } catch {
        // not installed at this root
      }
    }
    if (installedRoots.length === 0) {
      results.push({ pkg, action: 'skipped', message: `${pkg}: not installed — skipped` });
      continue;
    }
    for (const root of installedRoots) {
      if (!sidecars.has(root)) sidecars.set(root, await readSidecar(root));
      const location = relative(cwd, root) || undefined;
      results.push(await linkOne(root, cwd, pkg, relPath, sidecars.get(root)!, location));
    }
  }

  for (const [root, sidecar] of sidecars) {
    await writeSidecar(root, sidecar);
  }
  return results;
}

// ----------------------------------------------------------------
// unlink
// ----------------------------------------------------------------

async function unlinkOne(
  root: string,
  pkg: string,
  sidecar: Record<string, string>,
  location: string | undefined,
): Promise<DevLinkOpResult> {
  const nm = nmPath(root, pkg);
  const label = pkgLabel(pkg, location);

  let entryStat;
  try {
    entryStat = await lstat(nm);
  } catch {
    delete sidecar[pkg];
    return { pkg, location, action: 'noop', message: `${label}: not installed` };
  }
  if (!entryStat.isSymbolicLink()) {
    return { pkg, location, action: 'noop', message: `${label}: node_modules entry is a real directory — untouched` };
  }

  const currentTarget = await readlink(nm);
  if (isStoreTarget(nm, currentTarget)) {
    delete sidecar[pkg];
    return { pkg, location, action: 'noop', message: `${label}: already published` };
  }

  const recorded = sidecar[pkg];
  if (recorded !== undefined) {
    const recordedAbs = resolve(dirname(nm), recorded);
    const stillResolves = (await realpathOrNull(recordedAbs)) !== null;
    if (stillResolves) {
      await unlink(nm);
      await symlink(recorded, nm, 'dir');
      delete sidecar[pkg];
      return { pkg, location, action: 'restored', message: `${label}: restored → ${recorded}` };
    }
  }

  await unlink(nm);
  delete sidecar[pkg];
  return {
    pkg,
    location,
    action: 'removed',
    message: `${label}: link removed but the original target is gone — run pnpm install to restore the published package`,
  };
}

/**
 * Restores linked packages to their original pnpm-installed symlinks, at every
 * install root where an entry (or a sidecar record) exists. A 'removed' result
 * (no restorable original) is the only failure state.
 */
export async function unlinkPackages(
  config: DevLinkConfig,
  options: DevLinkOptions = {},
): Promise<DevLinkOpResult[]> {
  const cwd = options.cwd ?? process.cwd();
  const selected = selectPackages(config, options.packages);
  const roots = await getInstallRoots(cwd);
  const sidecars = new Map<string, Record<string, string>>();
  for (const root of roots) {
    sidecars.set(root, await readSidecar(root));
  }

  const results: DevLinkOpResult[] = [];
  for (const [pkg] of selected) {
    const perPkg: DevLinkOpResult[] = [];
    for (const root of roots) {
      const sidecar = sidecars.get(root)!;
      const hasEntry = await lstat(nmPath(root, pkg)).then(
        () => true,
        () => false,
      );
      if (!hasEntry && !(pkg in sidecar)) continue;
      const location = relative(cwd, root) || undefined;
      perPkg.push(await unlinkOne(root, pkg, sidecar, location));
    }
    if (perPkg.length === 0) {
      perPkg.push({ pkg, action: 'noop', message: `${pkg}: not installed` });
    }
    results.push(...perPkg);
  }

  for (const [root, sidecar] of sidecars) {
    await writeSidecar(root, sidecar);
  }
  return results;
}

// ----------------------------------------------------------------
// status
// ----------------------------------------------------------------

async function statusOne(
  root: string,
  cwd: string,
  pkg: string,
  relPath: string,
  location: string | undefined,
): Promise<DevLinkStatusEntry> {
  const nm = nmPath(root, pkg);
  const localAbs = resolve(cwd, relPath);

  let checkout: CheckoutState = 'ready';
  let localVersion: string | undefined;
  const localManifest = await readManifest(localAbs);
  if (!localManifest) {
    checkout = 'missing';
  } else {
    localVersion = localManifest.version;
    if ((await missingArtifacts(localAbs, localManifest)).length > 0) checkout = 'not-built';
  }

  let install: InstallState;
  let installedVersion: string | undefined;
  let entryStat;
  try {
    entryStat = await lstat(nm);
  } catch {
    entryStat = null;
  }

  if (!entryStat) {
    install = 'not-installed';
  } else if (!entryStat.isSymbolicLink()) {
    install = 'not-symlink';
    installedVersion = (await readManifest(nm))?.version;
  } else {
    const currentReal = await realpathOrNull(nm);
    const localReal = await realpathOrNull(localAbs);
    if (currentReal !== null && localReal !== null && currentReal === localReal) {
      install = 'linked';
      installedVersion = localVersion;
    } else {
      install = 'published';
      installedVersion = currentReal ? (await readManifest(currentReal))?.version : undefined;
    }
  }

  return { pkg, location, localPath: relPath, install, checkout, installedVersion, localVersion };
}

/**
 * Reports each mapped package's state, derived by stat-ing the real symlink
 * targets — never trusted from the sidecar. A package installed in several
 * places (workspace root, member projects) gets one entry per install root; a
 * package installed nowhere gets a single root 'not-installed' entry. Sidecar
 * entries for packages that are no longer linked mean a real pnpm install
 * reset the overlay.
 */
export async function getDevLinkStatus(
  config: DevLinkConfig,
  options: DevLinkOptions = {},
): Promise<DevLinkStatusReport> {
  const cwd = options.cwd ?? process.cwd();
  const selected = selectPackages(config, options.packages);
  const roots = await getInstallRoots(cwd);

  const entries: DevLinkStatusEntry[] = [];
  const byRootPkg = new Map<string, DevLinkStatusEntry>();
  for (const [pkg, relPath] of selected) {
    const perPkg: DevLinkStatusEntry[] = [];
    for (const root of roots) {
      const hasEntry = await lstat(nmPath(root, pkg)).then(
        () => true,
        () => false,
      );
      if (!hasEntry) continue;
      const location = relative(cwd, root) || undefined;
      const entry = await statusOne(root, cwd, pkg, relPath, location);
      byRootPkg.set(`${root}\0${pkg}`, entry);
      perPkg.push(entry);
    }
    if (perPkg.length === 0) {
      const entry = await statusOne(resolve(cwd), cwd, pkg, relPath, undefined);
      byRootPkg.set(`${resolve(cwd)}\0${pkg}`, entry);
      perPkg.push(entry);
    }
    entries.push(...perPkg);
  }

  const resetByInstall: string[] = [];
  for (const root of roots) {
    const sidecar = await readSidecar(root);
    for (const pkg of Object.keys(sidecar)) {
      const entry = byRootPkg.get(`${root}\0${pkg}`);
      if (entry?.install === 'published' && !resetByInstall.includes(pkg)) {
        resetByInstall.push(pkg);
      }
    }
  }

  return { entries, resetByInstall };
}

// ----------------------------------------------------------------
// auto
// ----------------------------------------------------------------

export interface AutoLinkResult {
  /** False when the guards (DEV_LOCAL, CI, no config) kept auto from running. */
  ran: boolean;
  results: DevLinkOpResult[];
}

/**
 * The postinstall entry point: links everything mapped, but only inside a
 * DEV_LOCAL=true environment and never under CI. All problems are
 * warn-and-skip — auto must never fail an install.
 */
export async function autoLink(
  options: DevLinkOptions & { configPath?: string } = {},
): Promise<AutoLinkResult> {
  if (process.env.DEV_LOCAL !== 'true' || isCIEnvironment()) {
    return { ran: false, results: [] };
  }

  const cwd = options.cwd ?? process.cwd();
  const config = await loadDevLinkConfig(cwd, options.configPath);
  if (!config) return { ran: false, results: [] };

  const results = await linkPackages(config, { cwd, packages: options.packages });
  return { ran: true, results };
}
