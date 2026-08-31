import { lstat, readFile, readlink, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { parseJson } from '../json/jsonc.js';
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
  cwd: string,
  pkg: string,
  relPath: string,
  sidecar: Record<string, string>,
): Promise<DevLinkOpResult> {
  const nm = nmPath(cwd, pkg);

  let entryStat;
  try {
    entryStat = await lstat(nm);
  } catch {
    return { pkg, action: 'skipped', message: `${pkg}: not installed — skipped` };
  }
  if (!entryStat.isSymbolicLink()) {
    return {
      pkg,
      action: 'skipped',
      message: `${pkg}: node_modules entry is a real directory — skipped (dev-link never replaces one)`,
    };
  }

  const localAbs = resolve(cwd, relPath);
  const localManifest = await readManifest(localAbs);
  if (!localManifest) {
    return { pkg, action: 'skipped', message: `${pkg}: checkout not found at ${relPath} — skipped` };
  }

  const missing = await missingArtifacts(localAbs, localManifest);
  if (missing.length > 0) {
    return {
      pkg,
      action: 'refused',
      message: `${pkg}: not built (missing ${missing.join(', ')}) — run pnpm build in ${relPath}`,
    };
  }

  const localReal = await realpathOrNull(localAbs);
  const currentReal = await realpathOrNull(nm);
  if (localReal !== null && currentReal === localReal) {
    return { pkg, action: 'already-linked', message: `${pkg}: already linked → ${relPath}` };
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
    action: 'linked',
    message: `linked ${pkg} → ${relPath} (local ${localVersion}, was ${previousVersion})`,
  };
}

/**
 * Repoints installed `node_modules/<pkg>` symlinks at local checkouts.
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
  const sidecar = await readSidecar(cwd);

  const results: DevLinkOpResult[] = [];
  for (const [pkg, relPath] of selected) {
    results.push(await linkOne(cwd, pkg, relPath, sidecar));
  }

  await writeSidecar(cwd, sidecar);
  return results;
}

// ----------------------------------------------------------------
// unlink
// ----------------------------------------------------------------

async function unlinkOne(
  cwd: string,
  pkg: string,
  sidecar: Record<string, string>,
): Promise<DevLinkOpResult> {
  const nm = nmPath(cwd, pkg);

  let entryStat;
  try {
    entryStat = await lstat(nm);
  } catch {
    delete sidecar[pkg];
    return { pkg, action: 'noop', message: `${pkg}: not installed` };
  }
  if (!entryStat.isSymbolicLink()) {
    return { pkg, action: 'noop', message: `${pkg}: node_modules entry is a real directory — untouched` };
  }

  const currentTarget = await readlink(nm);
  if (isStoreTarget(nm, currentTarget)) {
    delete sidecar[pkg];
    return { pkg, action: 'noop', message: `${pkg}: already published` };
  }

  const recorded = sidecar[pkg];
  if (recorded !== undefined) {
    const recordedAbs = resolve(dirname(nm), recorded);
    const stillResolves = (await realpathOrNull(recordedAbs)) !== null;
    if (stillResolves) {
      await unlink(nm);
      await symlink(recorded, nm, 'dir');
      delete sidecar[pkg];
      return { pkg, action: 'restored', message: `${pkg}: restored → ${recorded}` };
    }
  }

  await unlink(nm);
  delete sidecar[pkg];
  return {
    pkg,
    action: 'removed',
    message: `${pkg}: link removed but the original target is gone — run pnpm install to restore the published package`,
  };
}

/**
 * Restores linked packages to their original pnpm-installed symlinks. A
 * 'removed' result (no restorable original) is the only failure state.
 */
export async function unlinkPackages(
  config: DevLinkConfig,
  options: DevLinkOptions = {},
): Promise<DevLinkOpResult[]> {
  const cwd = options.cwd ?? process.cwd();
  const selected = selectPackages(config, options.packages);
  const sidecar = await readSidecar(cwd);

  const results: DevLinkOpResult[] = [];
  for (const [pkg] of selected) {
    results.push(await unlinkOne(cwd, pkg, sidecar));
  }

  await writeSidecar(cwd, sidecar);
  return results;
}

// ----------------------------------------------------------------
// status
// ----------------------------------------------------------------

async function statusOne(cwd: string, pkg: string, relPath: string): Promise<DevLinkStatusEntry> {
  const nm = nmPath(cwd, pkg);
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

  return { pkg, localPath: relPath, install, checkout, installedVersion, localVersion };
}

/**
 * Reports each mapped package's state, derived by stat-ing the real symlink
 * targets — never trusted from the sidecar. Sidecar entries for packages that
 * are no longer linked mean a real pnpm install reset the overlay.
 */
export async function getDevLinkStatus(
  config: DevLinkConfig,
  options: DevLinkOptions = {},
): Promise<DevLinkStatusReport> {
  const cwd = options.cwd ?? process.cwd();
  const selected = selectPackages(config, options.packages);

  const entries: DevLinkStatusEntry[] = [];
  for (const [pkg, relPath] of selected) {
    entries.push(await statusOne(cwd, pkg, relPath));
  }

  const sidecar = await readSidecar(cwd);
  const byPkg = new Map(entries.map((e) => [e.pkg, e]));
  const resetByInstall = Object.keys(sidecar).filter((pkg) => byPkg.get(pkg)?.install === 'published');

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
