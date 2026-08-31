import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoLink, getDevLinkStatus, linkPackages, unlinkPackages } from './engine.js';
import { loadDevLinkConfig } from './config.js';
import type { DevLinkConfig } from './types.js';

const PKG = '@scope/pkg';
/** Relative store target, exactly as pnpm writes it for a scoped package. */
const STORE_TARGET = join('..', '.pnpm', '@scope+pkg@1.0.0', 'node_modules', '@scope', 'pkg');

describe('dev-link engine', () => {
  let testDir: string;
  let repoDir: string;
  let localDir: string;
  let config: DevLinkConfig;

  /** node_modules path of the installed package entry. */
  const nm = () => join(repoDir, 'node_modules', '@scope', 'pkg');
  const sidecarPath = () => join(repoDir, 'node_modules', '.dev-link.json');

  beforeEach(async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');

    testDir = join(tmpdir(), `test-dev-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoDir = join(testDir, 'repo');
    localDir = join(testDir, 'local', 'pkg');

    // Installed package in the pnpm store layout, reached via a relative symlink.
    const storeDir = join(repoDir, 'node_modules', '.pnpm', '@scope+pkg@1.0.0', 'node_modules', '@scope', 'pkg');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'package.json'), JSON.stringify({ name: PKG, version: '1.0.0' }));
    await mkdir(join(repoDir, 'node_modules', '@scope'), { recursive: true });
    await symlink(STORE_TARGET, nm(), 'dir');

    // Local checkout: source-mode main, artifacts under dist (built by default).
    await mkdir(join(localDir, 'dist'), { recursive: true });
    await mkdir(join(localDir, 'src'), { recursive: true });
    await writeFile(join(localDir, 'src', 'index.ts'), 'export {};');
    await writeFile(join(localDir, 'dist', 'index.js'), 'module.exports = {};');
    await writeFile(join(localDir, 'dist', 'bin.js'), '#!/usr/bin/env node');
    await writeFile(
      join(localDir, 'package.json'),
      JSON.stringify({
        name: PKG,
        version: '2.0.0-dev.0',
        main: './src/index.ts',
        publishConfig: { main: './dist/index.js' },
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        bin: { pkg: './dist/bin.js' },
      }),
    );

    config = { packages: { [PKG]: '../local/pkg' } };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(testDir, { recursive: true, force: true });
  });

  it('link/unlink round-trip restores the original relative symlink byte-identically', async () => {
    const linked = await linkPackages(config, { cwd: repoDir });
    expect(linked[0].action).toBe('linked');
    expect(linked[0].message).toContain('local 2.0.0-dev.0');
    expect(linked[0].message).toContain('was 1.0.0');

    // Linked: absolute symlink at the checkout, sidecar holds the original target.
    const sidecar = JSON.parse(await readFile(sidecarPath(), 'utf-8'));
    expect(sidecar[PKG]).toBe(STORE_TARGET);

    const unlinked = await unlinkPackages(config, { cwd: repoDir });
    expect(unlinked[0].action).toBe('restored');
    expect(await readlink(nm())).toBe(STORE_TARGET);

    // Sidecar emptied → file deleted.
    await expect(readFile(sidecarPath(), 'utf-8')).rejects.toThrow();
  });

  it('re-link is idempotent and does not disturb the sidecar record', async () => {
    await linkPackages(config, { cwd: repoDir });
    const again = await linkPackages(config, { cwd: repoDir });
    expect(again[0].action).toBe('already-linked');

    const sidecar = JSON.parse(await readFile(sidecarPath(), 'utf-8'));
    expect(sidecar[PKG]).toBe(STORE_TARGET);
  });

  it('sidecar records are first-seen: relinking over a foreign target never overwrites', async () => {
    await linkPackages(config, { cwd: repoDir });
    // Simulate something else repointing the entry (not a store target).
    await rm(nm());
    await symlink(join(testDir, 'local'), nm(), 'dir');
    await linkPackages(config, { cwd: repoDir });

    const sidecar = JSON.parse(await readFile(sidecarPath(), 'utf-8'));
    expect(sidecar[PKG]).toBe(STORE_TARGET);
  });

  it('refuses to link an unbuilt checkout, naming the missing artifact', async () => {
    await rm(join(localDir, 'dist'), { recursive: true });
    const results = await linkPackages(config, { cwd: repoDir });
    expect(results[0].action).toBe('refused');
    expect(results[0].message).toContain('not built');
    expect(results[0].message).toContain('run pnpm build in ../local/pkg');
    // Entry untouched.
    expect(await readlink(nm())).toBe(STORE_TARGET);
  });

  it('refuses to run under CI', async () => {
    vi.stubEnv('CI', 'true');
    await expect(linkPackages(config, { cwd: repoDir })).rejects.toThrow(/CI/);
  });

  it('never replaces a real directory', async () => {
    await rm(nm());
    await mkdir(nm(), { recursive: true });
    await writeFile(join(nm(), 'package.json'), JSON.stringify({ name: PKG, version: '1.0.0' }));

    const results = await linkPackages(config, { cwd: repoDir });
    expect(results[0].action).toBe('skipped');
    expect(results[0].message).toContain('real directory');
  });

  it('skips packages that are not installed or whose checkout is missing', async () => {
    await rm(nm());
    expect((await linkPackages(config, { cwd: repoDir }))[0].message).toContain('not installed');

    await symlink(STORE_TARGET, nm(), 'dir');
    const cfg = { packages: { [PKG]: '../local/nowhere' } };
    expect((await linkPackages(cfg, { cwd: repoDir }))[0].message).toContain('checkout not found');
  });

  it('status reflects reality and flags sidecar entries reset by a pnpm install', async () => {
    let report = await getDevLinkStatus(config, { cwd: repoDir });
    expect(report.entries[0]).toMatchObject({ install: 'published', checkout: 'ready', installedVersion: '1.0.0' });

    await linkPackages(config, { cwd: repoDir });
    report = await getDevLinkStatus(config, { cwd: repoDir });
    expect(report.entries[0]).toMatchObject({ install: 'linked', localVersion: '2.0.0-dev.0' });
    expect(report.resetByInstall).toEqual([]);

    // Simulate a real pnpm install rewriting the entry back to the store.
    await rm(nm());
    await symlink(STORE_TARGET, nm(), 'dir');
    report = await getDevLinkStatus(config, { cwd: repoDir });
    expect(report.entries[0].install).toBe('published');
    expect(report.resetByInstall).toEqual([PKG]);
  });

  it('unlink with a vanished original removes the link and reports it', async () => {
    await linkPackages(config, { cwd: repoDir });
    await rm(join(repoDir, 'node_modules', '.pnpm'), { recursive: true });

    const results = await unlinkPackages(config, { cwd: repoDir });
    expect(results[0].action).toBe('removed');
    expect(results[0].message).toContain('pnpm install');
  });

  it('rejects package args that are not in the map', async () => {
    await expect(linkPackages(config, { cwd: repoDir, packages: ['@scope/other'] })).rejects.toThrow(
      /Not in the dev-link map/,
    );
  });

  it('auto is gated on DEV_LOCAL and CI, and never throws on problems', async () => {
    vi.stubEnv('DEV_LOCAL', '');
    expect((await autoLink({ cwd: repoDir })).ran).toBe(false);

    vi.stubEnv('DEV_LOCAL', 'true');
    vi.stubEnv('CI', 'true');
    expect((await autoLink({ cwd: repoDir })).ran).toBe(false);

    vi.stubEnv('CI', '');
    await mkdir(join(repoDir, '.publish'), { recursive: true });
    await writeFile(
      join(repoDir, '.publish', 'dev-local.yml'),
      `packages:\n  '${PKG}': ../local/pkg\n`,
    );
    const result = await autoLink({ cwd: repoDir });
    expect(result.ran).toBe(true);
    expect(result.results[0].action).toBe('linked');
  });

  it('links, reports, and unlinks nested member-project installs in a pnpm workspace', async () => {
    // Same package also installed in a member project's own node_modules — the
    // entry Node actually resolves for that project's code.
    const NESTED_TARGET = join(
      '..', '..', '..', '..',
      'node_modules', '.pnpm', '@scope+pkg@1.0.0', 'node_modules', '@scope', 'pkg',
    );
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ name: 'root', private: true }));
    await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const appDir = join(repoDir, 'packages', 'app');
    const appNm = join(appDir, 'node_modules', '@scope', 'pkg');
    await mkdir(join(appDir, 'node_modules', '@scope'), { recursive: true });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }));
    await symlink(NESTED_TARGET, appNm, 'dir');

    const linked = await linkPackages(config, { cwd: repoDir });
    expect(linked.map((r) => [r.action, r.location])).toEqual([
      ['linked', undefined],
      ['linked', join('packages', 'app')],
    ]);

    const report = await getDevLinkStatus(config, { cwd: repoDir });
    expect(report.entries.map((e) => [e.install, e.location])).toEqual([
      ['linked', undefined],
      ['linked', join('packages', 'app')],
    ]);

    // Each install root keeps its own sidecar, so unlink restores both entries
    // byte-identically.
    const nestedSidecar = JSON.parse(
      await readFile(join(appDir, 'node_modules', '.dev-link.json'), 'utf-8'),
    );
    expect(nestedSidecar[PKG]).toBe(NESTED_TARGET);

    const unlinked = await unlinkPackages(config, { cwd: repoDir });
    expect(unlinked.map((r) => r.action)).toEqual(['restored', 'restored']);
    expect(await readlink(nm())).toBe(STORE_TARGET);
    expect(await readlink(appNm)).toBe(NESTED_TARGET);
  });

  it('auto without a config is a silent no-op', async () => {
    vi.stubEnv('DEV_LOCAL', 'true');
    expect((await autoLink({ cwd: repoDir })).ran).toBe(false);
  });
});

describe('loadDevLinkConfig', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `test-dev-link-cfg-${Date.now()}`);
    await mkdir(join(testDir, '.publish'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns null for missing or empty config', async () => {
    expect(await loadDevLinkConfig(testDir)).toBeNull();
    await writeFile(join(testDir, '.publish', 'dev-local.yml'), 'packages: {}\n');
    expect(await loadDevLinkConfig(testDir)).toBeNull();
  });

  it('loads the package map', async () => {
    await writeFile(
      join(testDir, '.publish', 'dev-local.yml'),
      "packages:\n  '@cpdevtools/git-flow': ../git-flow/packages/git-flow\n",
    );
    const config = await loadDevLinkConfig(testDir);
    expect(config?.packages['@cpdevtools/git-flow']).toBe('../git-flow/packages/git-flow');
  });

  it('rejects non-string paths', async () => {
    await writeFile(join(testDir, '.publish', 'dev-local.yml'), "packages:\n  '@scope/pkg': 42\n");
    await expect(loadDevLinkConfig(testDir)).rejects.toThrow(/must be a non-empty path string/);
  });
});
