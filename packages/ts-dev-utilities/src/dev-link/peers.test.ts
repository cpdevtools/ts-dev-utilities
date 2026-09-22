import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDevLinkStatus, linkPackages, unlinkPackages } from './engine.js';
import { loadDevLinkConfig } from './config.js';
import type { DevLinkConfig } from './types.js';

const PKG = '@scope/pkg';
const PEER = '@ng/core';
const STORE_TARGET = join('..', '.pnpm', '@scope+pkg@1.0.0', 'node_modules', '@scope', 'pkg');
const PEER_STORE_TARGET = join('..', '.pnpm', '@ng+core@1.2.0', 'node_modules', '@ng', 'core');

/** Peer-dependency behaviour of dev-link: the checkout's peers resolve to the consumer's copies. */
describe('dev-link peers', () => {
  let testDir: string;
  let repoDir: string;
  let localDir: string;
  let config: DevLinkConfig;

  const nm = () => join(repoDir, 'node_modules', '@scope', 'pkg');
  const hostPeer = () => join(repoDir, 'node_modules', '@ng', 'core');
  const checkoutPeer = () => join(localDir, 'node_modules', '@ng', 'core');
  const sidecarPath = () => join(repoDir, 'node_modules', '.dev-link.json');
  const readSidecar = async () => JSON.parse(await readFile(sidecarPath(), 'utf-8'));
  const exists = async (p: string) => lstat(p).then(() => true, () => false);

  /** Install `name` the way pnpm does: real dir in the store, relative symlink from node_modules/<name>. */
  async function installStorePackage(root: string, name: string, version: string, relTarget: string): Promise<void> {
    const [scope] = name.split('/');
    const entry = join(root, 'node_modules', ...name.split('/'));
    const real = join(entry, '..', relTarget);
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'package.json'), JSON.stringify({ name, version }));
    await mkdir(join(root, 'node_modules', scope!), { recursive: true });
    await symlink(relTarget, entry, 'dir');
  }

  async function writeCheckoutManifest(extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      join(localDir, 'package.json'),
      JSON.stringify({
        name: PKG,
        version: '2.0.0-dev.0',
        main: './dist/index.js',
        peerDependencies: { [PEER]: '^1.0.0' },
        ...extra,
      }),
    );
  }

  beforeEach(async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    testDir = join(tmpdir(), `test-dev-link-peers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoDir = join(testDir, 'repo');
    localDir = join(testDir, 'local', 'pkg');

    await installStorePackage(repoDir, PKG, '1.0.0', STORE_TARGET);
    await installStorePackage(repoDir, PEER, '1.2.0', PEER_STORE_TARGET);

    await mkdir(join(localDir, 'dist'), { recursive: true });
    await writeFile(join(localDir, 'dist', 'index.js'), 'module.exports = {};');
    await writeCheckoutManifest();

    config = { packages: { [PKG]: '../local/pkg' } };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(testDir, { recursive: true, force: true });
  });

  it('links each declared peer to the consumer copy and unlink removes exactly what it created', async () => {
    const linked = await linkPackages(config, { cwd: repoDir });
    expect(linked.map((r) => r.action)).toEqual(['linked', 'peer-linked']);
    expect(linked[1].peer).toBe(PEER);
    expect(linked[1].message).toContain('1.2.0');

    // The checkout's peer entry resolves to the very same directory as the host's.
    expect(await realpath(checkoutPeer())).toBe(await realpath(hostPeer()));

    const sidecar = await readSidecar();
    expect(sidecar.version).toBe(2);
    expect(sidecar.targets[PKG]).toBe(STORE_TARGET);
    expect(sidecar.peers[PKG].entries[PEER]).toBeNull();
    expect(sidecar.peers[PKG].created).toEqual([
      join(localDir, 'node_modules'),
      join(localDir, 'node_modules', '@ng'),
    ]);

    const unlinked = await unlinkPackages(config, { cwd: repoDir });
    expect(unlinked.map((r) => r.action)).toEqual(['peer-restored', 'restored']);
    expect(await readlink(nm())).toBe(STORE_TARGET);
    // node_modules inside the checkout was ours, so it is gone again.
    expect(await exists(join(localDir, 'node_modules'))).toBe(false);
    await expect(readFile(sidecarPath(), 'utf-8')).rejects.toThrow();
  });

  it('restores the checkout own peer entry when one existed before linking', async () => {
    // The checkout has its own installed copy of the peer (a store symlink of its own).
    const ownStore = join(localDir, 'node_modules', '.pnpm', '@ng+core@1.0.0', 'node_modules', '@ng', 'core');
    await mkdir(ownStore, { recursive: true });
    await writeFile(join(ownStore, 'package.json'), JSON.stringify({ name: PEER, version: '1.0.0' }));
    await mkdir(join(localDir, 'node_modules', '@ng'), { recursive: true });
    const ownTarget = join('..', '.pnpm', '@ng+core@1.0.0', 'node_modules', '@ng', 'core');
    await symlink(ownTarget, checkoutPeer(), 'dir');

    await linkPackages(config, { cwd: repoDir });
    expect(await realpath(checkoutPeer())).toBe(await realpath(hostPeer()));
    const sidecar = await readSidecar();
    expect(sidecar.peers[PKG].entries[PEER]).toBe(ownTarget);
    expect(sidecar.peers[PKG].created).toEqual([]); // nothing had to be created

    await unlinkPackages(config, { cwd: repoDir });
    expect(await readlink(checkoutPeer())).toBe(ownTarget);
    expect(await exists(join(localDir, 'node_modules', '.pnpm'))).toBe(true); // untouched
  });

  it('never replaces a real directory inside the checkout', async () => {
    await mkdir(checkoutPeer(), { recursive: true });
    await writeFile(join(checkoutPeer(), 'package.json'), '{}');
    const linked = await linkPackages(config, { cwd: repoDir });
    expect(linked.map((r) => r.action)).toEqual(['linked', 'peer-skipped']);
    expect((await lstat(checkoutPeer())).isDirectory()).toBe(true);
  });

  it('reports a peer the consumer does not have, distinguishing optional peers', async () => {
    await rm(hostPeer());
    let linked = await linkPackages(config, { cwd: repoDir });
    expect(linked.map((r) => r.action)).toEqual(['linked', 'peer-missing']);
    expect(linked[1].message).toContain('two instances');
    let status = await getDevLinkStatus(config, { cwd: repoDir });
    expect(status.entries[0].peers).toEqual([{ peer: PEER, state: 'missing', range: '^1.0.0' }]);
    expect(await exists(join(localDir, 'node_modules'))).toBe(false);

    await unlinkPackages(config, { cwd: repoDir });
    await writeCheckoutManifest({ peerDependenciesMeta: { [PEER]: { optional: true } } });
    linked = await linkPackages(config, { cwd: repoDir });
    expect(linked[1].action).toBe('peer-missing');
    expect(linked[1].message).toContain('optional');
    status = await getDevLinkStatus(config, { cwd: repoDir });
    expect(status.entries[0].peers?.[0].state).toBe('optional-missing');
  });

  it('flags a consumer version outside the declared range but still links it', async () => {
    await writeCheckoutManifest({ peerDependencies: { [PEER]: '^2.0.0' } });
    const linked = await linkPackages(config, { cwd: repoDir });
    expect(linked[1].action).toBe('peer-mismatch');
    expect(linked[1].message).toContain('does not satisfy');
    expect(await realpath(checkoutPeer())).toBe(await realpath(hostPeer()));
    const status = await getDevLinkStatus(config, { cwd: repoDir });
    expect(status.entries[0].peers).toEqual([
      { peer: PEER, state: 'linked', range: '^2.0.0', hostVersion: '1.2.0', satisfies: false },
    ]);
  });

  it('treats configured `shared` names like declared peers', async () => {
    await writeCheckoutManifest({ peerDependencies: {}, dependencies: { [PEER]: '^1.0.0' } });
    let linked = await linkPackages(config, { cwd: repoDir });
    expect(linked.map((r) => r.action)).toEqual(['linked']);
    await unlinkPackages(config, { cwd: repoDir });

    config.packageOptions = { [PKG]: { shared: [PEER] } };
    linked = await linkPackages(config, { cwd: repoDir });
    expect(linked.map((r) => r.action)).toEqual(['linked', 'peer-linked']);
    const status = await getDevLinkStatus(config, { cwd: repoDir });
    expect(status.entries[0].peers).toEqual([{ peer: PEER, state: 'linked', hostVersion: '1.2.0' }]);
  });

  it('can be switched off globally or per package', async () => {
    let linked = await linkPackages({ ...config, peers: false }, { cwd: repoDir });
    expect(linked.map((r) => r.action)).toEqual(['linked']);
    expect(await exists(join(localDir, 'node_modules'))).toBe(false);
    await unlinkPackages(config, { cwd: repoDir });

    linked = await linkPackages({ ...config, packageOptions: { [PKG]: { peers: false } } }, { cwd: repoDir });
    expect(linked.map((r) => r.action)).toEqual(['linked']);
    expect(await exists(join(localDir, 'node_modules'))).toBe(false);
  });

  it('re-running on an already-linked package heals peer links a rebuild wiped', async () => {
    await linkPackages(config, { cwd: repoDir });
    // A clean rebuild of the checkout removed its node_modules (and our links).
    await rm(join(localDir, 'node_modules'), { recursive: true, force: true });

    const again = await linkPackages(config, { cwd: repoDir });
    expect(again.map((r) => r.action)).toEqual(['already-linked', 'peer-linked']);
    expect(await realpath(checkoutPeer())).toBe(await realpath(hostPeer()));

    // And a plain re-run with everything in place is quiet about peers.
    const quiet = await linkPackages(config, { cwd: repoDir });
    expect(quiet.map((r) => r.action)).toEqual(['already-linked']);
  });

  it('reads a version-1 sidecar written by an older CLI', async () => {
    await linkPackages(config, { cwd: repoDir });
    await writeFile(sidecarPath(), JSON.stringify({ [PKG]: STORE_TARGET }));

    const unlinked = await unlinkPackages(config, { cwd: repoDir });
    expect(unlinked.map((r) => r.action)).toEqual(['restored']);
    expect(await readlink(nm())).toBe(STORE_TARGET);
  });

  it('config accepts the object form with peers and shared', async () => {
    await mkdir(join(repoDir, '.publish'), { recursive: true });
    await writeFile(
      join(repoDir, '.publish', 'dev-local.yml'),
      [
        'peers: true',
        'packages:',
        `  '${PKG}':`,
        '    path: ../local/pkg',
        '    peers: false',
        "    shared: ['rxjs']",
        "  '@scope/other': ../local/other",
      ].join('\n'),
    );
    const loaded = await loadDevLinkConfig(repoDir);
    expect(loaded).toEqual({
      packages: { [PKG]: '../local/pkg', '@scope/other': '../local/other' },
      peers: true,
      packageOptions: { [PKG]: { peers: false, shared: ['rxjs'] } },
    });

    await writeFile(join(repoDir, '.publish', 'dev-local.yml'), `packages:\n  '${PKG}':\n    shared: 1\n`);
    await expect(loadDevLinkConfig(repoDir)).rejects.toThrow(/non-empty path string or/);
  });
});
