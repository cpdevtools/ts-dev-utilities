import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverProjects } from './discover.js';

describe('discoverProjects', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `test-discover-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  it('should find package.json files in workspace', async () => {
    // Create test structure
    await mkdir(join(testDir, 'packages/pkg1'), { recursive: true });
    await mkdir(join(testDir, 'packages/pkg2'), { recursive: true });
    
    await writeFile(
      join(testDir, 'packages/pkg1/package.json'),
      JSON.stringify({ name: 'pkg1', version: '1.0.0' }),
    );
    await writeFile(
      join(testDir, 'packages/pkg2/package.json'),
      JSON.stringify({ name: 'pkg2', version: '2.0.0' }),
    );

    const projects = await discoverProjects({
      cwd: testDir,
      patterns: ['packages/*/package.json'],
    });

    expect(projects).toHaveLength(2);
    expect(projects[0].packageJson.name).toBe('pkg1');
    expect(projects[1].packageJson.name).toBe('pkg2');
  });

  it('should handle package.json with comments', async () => {
    await writeFile(
      join(testDir, 'package.json'),
      `{
        "name": "test",
        // This is a comment
        "version": "1.0.0"
      }`,
    );

    const projects = await discoverProjects({
      cwd: testDir,
      patterns: ['package.json'],
    });

    expect(projects).toHaveLength(1);
    expect(projects[0].packageJson.name).toBe('test');
  });

  it('should exclude node_modules by default', async () => {
    await mkdir(join(testDir, 'node_modules/dep'), { recursive: true });
    await writeFile(
      join(testDir, 'node_modules/dep/package.json'),
      JSON.stringify({ name: 'dep' }),
    );
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'root' }),
    );

    const projects = await discoverProjects({
      cwd: testDir,
    });

    expect(projects).toHaveLength(1);
    expect(projects[0].packageJson.name).toBe('root');
  });

  it('should return empty array when no projects found', async () => {
    const projects = await discoverProjects({
      cwd: testDir,
      patterns: ['nonexistent/*/package.json'],
    });

    expect(projects).toHaveLength(0);
  });

  it('should skip invalid package.json files', async () => {
    await writeFile(join(testDir, 'valid.json'), JSON.stringify({ name: 'valid' }));
    await writeFile(join(testDir, 'invalid.json'), 'not valid json {');

    const projects = await discoverProjects({
      cwd: testDir,
      patterns: ['*.json'],
    });

    expect(projects).toHaveLength(1);
    expect(projects[0].packageJson.name).toBe('valid');
  });
});
