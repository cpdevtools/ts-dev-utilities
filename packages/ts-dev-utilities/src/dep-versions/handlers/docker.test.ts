import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dockerHandler } from './docker.js';

describe('dockerHandler', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `test-docker-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('check: detects outdated FROM tag', async () => {
    await writeFile(join(dir, 'Dockerfile'), 'FROM node:20\nRUN npm install\n');

    const changes = await dockerHandler.check(dir, { node: '24' });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ name: 'node', from: '20', to: '24' });
  });

  it('check: returns nothing when tag matches', async () => {
    await writeFile(join(dir, 'Dockerfile'), 'FROM node:24\n');
    const changes = await dockerHandler.check(dir, { node: '24' });
    expect(changes).toHaveLength(0);
  });

  it('check: does not write files', async () => {
    const dockerfilePath = join(dir, 'Dockerfile');
    const original = 'FROM node:20\n';
    await writeFile(dockerfilePath, original);

    await dockerHandler.check(dir, { node: '24' });

    expect(await readFile(dockerfilePath, 'utf-8')).toBe(original);
  });

  it('fix: rewrites FROM tag in Dockerfile', async () => {
    const dockerfilePath = join(dir, 'Dockerfile');
    await writeFile(dockerfilePath, 'FROM node:20-alpine\nRUN npm install\n');

    const changes = await dockerHandler.fix(dir, { node: '24-alpine' });

    expect(changes).toHaveLength(1);
    expect(await readFile(dockerfilePath, 'utf-8')).toContain('FROM node:24-alpine');
  });

  it('fix: rewrites image tag in docker-compose.yml', async () => {
    const composePath = join(dir, 'docker-compose.yml');
    await writeFile(
      composePath,
      `
services:
  app:
    image: node:20
`,
    );

    const changes = await dockerHandler.fix(dir, { node: '24' });

    expect(changes).toHaveLength(1);
    expect(await readFile(composePath, 'utf-8')).toContain('image: node:24');
  });

  it('fix: handles multi-segment image names', async () => {
    await writeFile(join(dir, 'Dockerfile'), 'FROM mcr.microsoft.com/dotnet/sdk:8.0\n');

    const changes = await dockerHandler.fix(dir, { 'mcr.microsoft.com/dotnet/sdk': '9.0' });

    expect(changes).toHaveLength(1);
    expect(await readFile(join(dir, 'Dockerfile'), 'utf-8')).toContain(
      'FROM mcr.microsoft.com/dotnet/sdk:9.0',
    );
  });
});

describe('dockerHandler: interpolated tags', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `test-docker-interp-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves an interpolated compose image tag alone', async () => {
    // A deploy bundle's tag is the released version, supplied at deploy time.
    const path = join(dir, 'docker-compose.yml');
    const original = 'services:\n  api:\n    image: ghcr.io/org/svc:${DEPLOY_IMAGE_TAG}\n';
    await writeFile(path, original);

    const changes = await dockerHandler.fix(dir, { 'ghcr.io/org/svc': '1.2.3' });

    expect(changes).toHaveLength(0);
    expect(await readFile(path, 'utf-8')).toBe(original);
  });

  it('leaves an interpolated FROM tag alone', async () => {
    const path = join(dir, 'Dockerfile');
    const original = 'FROM node:${NODE_VERSION}\n';
    await writeFile(path, original);

    const changes = await dockerHandler.fix(dir, { node: '24' });

    expect(changes).toHaveLength(0);
    expect(await readFile(path, 'utf-8')).toBe(original);
  });

  it('still updates a literal tag in a lowercase dockerfile', async () => {
    const path = join(dir, 'dockerfile');
    await writeFile(path, 'FROM node:20\n');

    const changes = await dockerHandler.fix(dir, { node: '24' });

    expect(changes).toHaveLength(1);
    expect(await readFile(path, 'utf-8')).toBe('FROM node:24\n');
  });
});
