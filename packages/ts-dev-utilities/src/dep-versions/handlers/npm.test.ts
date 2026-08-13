import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { npmHandler } from './npm.js';

describe('npmHandler', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `test-npm-handler-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('check: returns drift for outdated dep', async () => {
    await mkdir(join(dir, 'pkg-a'), { recursive: true });
    await writeFile(
      join(dir, 'pkg-a', 'package.json'),
      JSON.stringify({ name: 'pkg-a', dependencies: { typescript: '^5.0.0' } }),
    );

    const changes = await npmHandler.check(dir, { typescript: '^5.9.3' });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ name: 'typescript', from: '^5.0.0', to: '^5.9.3' });
  });

  it('check: returns nothing when versions match', async () => {
    await mkdir(join(dir, 'pkg-a'), { recursive: true });
    await writeFile(
      join(dir, 'pkg-a', 'package.json'),
      JSON.stringify({ name: 'pkg-a', dependencies: { typescript: '^5.9.3' } }),
    );

    const changes = await npmHandler.check(dir, { typescript: '^5.9.3' });
    expect(changes).toHaveLength(0);
  });

  it('check: does not write files', async () => {
    await mkdir(join(dir, 'pkg-a'), { recursive: true });
    const pkgPath = join(dir, 'pkg-a', 'package.json');
    const original = JSON.stringify({ name: 'pkg-a', dependencies: { typescript: '^5.0.0' } });
    await writeFile(pkgPath, original);

    await npmHandler.check(dir, { typescript: '^5.9.3' });

    expect(await readFile(pkgPath, 'utf-8')).toBe(original);
  });

  it('fix: updates matching dep and returns change', async () => {
    await mkdir(join(dir, 'pkg-a'), { recursive: true });
    const pkgPath = join(dir, 'pkg-a', 'package.json');
    await writeFile(
      pkgPath,
      JSON.stringify({ name: 'pkg-a', dependencies: { typescript: '^5.0.0' } }),
    );

    const changes = await npmHandler.fix(dir, { typescript: '^5.9.3' });

    expect(changes).toHaveLength(1);
    const updated = JSON.parse(await readFile(pkgPath, 'utf-8'));
    expect(updated.dependencies.typescript).toBe('^5.9.3');
  });

  it('fix: updates across all dep fields', async () => {
    await mkdir(join(dir, 'pkg-a'), { recursive: true });
    const pkgPath = join(dir, 'pkg-a', 'package.json');
    await writeFile(
      pkgPath,
      JSON.stringify({
        name: 'pkg-a',
        dependencies: { vitest: '^1.0.0' },
        devDependencies: { typescript: '^5.0.0' },
        peerDependencies: { react: '^17.0.0' },
      }),
    );

    const changes = await npmHandler.fix(dir, {
      typescript: '^5.9.3',
      vitest: '^2.1.0',
      react: '^18.0.0',
    });

    expect(changes).toHaveLength(3);
    const updated = JSON.parse(await readFile(pkgPath, 'utf-8'));
    expect(updated.dependencies.vitest).toBe('^2.1.0');
    expect(updated.devDependencies.typescript).toBe('^5.9.3');
    expect(updated.peerDependencies.react).toBe('^18.0.0');
  });

  it('fix: does not add deps that do not already exist', async () => {
    await mkdir(join(dir, 'pkg-a'), { recursive: true });
    const pkgPath = join(dir, 'pkg-a', 'package.json');
    await writeFile(pkgPath, JSON.stringify({ name: 'pkg-a', dependencies: {} }));

    const changes = await npmHandler.fix(dir, { newpkg: '^1.0.0' });

    expect(changes).toHaveLength(0);
    const updated = JSON.parse(await readFile(pkgPath, 'utf-8'));
    expect('newpkg' in updated.dependencies).toBe(false);
  });

  it('fix: updates multiple packages across the workspace', async () => {
    for (const name of ['pkg-a', 'pkg-b']) {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(
        join(dir, name, 'package.json'),
        JSON.stringify({ name, devDependencies: { typescript: '^5.0.0' } }),
      );
    }

    const changes = await npmHandler.fix(dir, { typescript: '^5.9.3' });

    expect(changes).toHaveLength(2);
    for (const name of ['pkg-a', 'pkg-b']) {
      const pkg = JSON.parse(await readFile(join(dir, name, 'package.json'), 'utf-8'));
      expect(pkg.devDependencies.typescript).toBe('^5.9.3');
    }
  });
});

describe('npmHandler: workspace root', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `test-npm-root-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    // A pnpm workspace, so discoverProjects scopes to members and skips the root.
    await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    await mkdir(join(dir, 'packages', 'pkg-a'), { recursive: true });
    await writeFile(
      join(dir, 'packages', 'pkg-a', 'package.json'),
      JSON.stringify({ name: 'pkg-a', devDependencies: { typescript: '^5.0.0' } }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('check: sees drift in the root manifest, not just members', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', private: true, devDependencies: { typescript: '^5.1.0' } }),
    );

    const changes = await npmHandler.check(dir, { typescript: '^5.9.3' });

    // Without the root the toolchain pin drifts while `check` reports green.
    expect(changes.map((c) => c.from).sort()).toEqual(['^5.0.0', '^5.1.0']);
  });

  it('fix: updates the root manifest', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', private: true, devDependencies: { typescript: '^5.1.0' } }),
    );

    await npmHandler.fix(dir, { typescript: '^5.9.3' });

    const root = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));
    expect(root.devDependencies.typescript).toBe('^5.9.3');
  });

  it('does not report the root twice when it is also a member', async () => {
    await rm(join(dir, 'pnpm-workspace.yaml'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', devDependencies: { typescript: '^5.1.0' } }),
    );

    const changes = await npmHandler.check(dir, { typescript: '^5.9.3' });

    expect(changes.filter((c) => c.file === join(dir, 'package.json'))).toHaveLength(1);
  });
});

describe('npmHandler: dockerfiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `test-npm-docker-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fix: updates an annotated ARG in a lowercase dockerfile', async () => {
    const path = join(dir, 'dockerfile');
    await writeFile(
      path,
      [
        'FROM node:24',
        '# dep-version: @scope/some-cli',
        'ARG SOME_CLI_VERSION=1.2.3',
        'RUN npm install -g "@scope/some-cli@${SOME_CLI_VERSION}"',
        '',
      ].join('\n'),
    );

    const changes = await npmHandler.fix(dir, { '@scope/some-cli': '2.0.0' });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ name: '@scope/some-cli', from: '1.2.3', to: '2.0.0' });

    const updated = await readFile(path, 'utf-8');
    expect(updated).toContain('ARG SOME_CLI_VERSION=2.0.0');
    // The interpolated install site must survive untouched.
    expect(updated).toContain('"@scope/some-cli@${SOME_CLI_VERSION}"');
  });

  it('leaves an unannotated ARG alone', async () => {
    await writeFile(join(dir, 'Dockerfile'), 'ARG SOME_CLI_VERSION=1.2.3\n');

    const changes = await npmHandler.check(dir, { '@scope/some-cli': '2.0.0' });

    expect(changes).toHaveLength(0);
  });

  it('fix: updates a literal name@version install site', async () => {
    const path = join(dir, 'Dockerfile');
    await writeFile(path, 'RUN npm install -g some-cli@1.2.3\n');

    const changes = await npmHandler.fix(dir, { 'some-cli': '2.0.0' });

    expect(changes).toHaveLength(1);
    expect(await readFile(path, 'utf-8')).toBe('RUN npm install -g some-cli@2.0.0\n');
  });

  it('check: does not write dockerfiles', async () => {
    const path = join(dir, 'dockerfile');
    const original = '# dep-version: @scope/some-cli\nARG SOME_CLI_VERSION=1.2.3\n';
    await writeFile(path, original);

    await npmHandler.check(dir, { '@scope/some-cli': '2.0.0' });

    expect(await readFile(path, 'utf-8')).toBe(original);
  });
});
