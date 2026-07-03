import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { githubActionsHandler } from './github-actions.js';

const WORKFLOW = (version: string) => `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${version}
      - uses: actions/setup-node@${version}
`;

describe('githubActionsHandler', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `test-gh-actions-${Date.now()}`);
    await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('check: detects outdated action versions', async () => {
    const wfPath = join(dir, '.github', 'workflows', 'ci.yml');
    await writeFile(wfPath, WORKFLOW('v4'));

    const changes = await githubActionsHandler.check(dir, { 'actions/checkout': 'v7', 'actions/setup-node': 'v6' });

    expect(changes).toHaveLength(2);
    expect(changes.find(c => c.name === 'actions/checkout')).toMatchObject({ from: 'v4', to: 'v7' });
    expect(changes.find(c => c.name === 'actions/setup-node')).toMatchObject({ from: 'v4', to: 'v6' });
  });

  it('check: returns nothing when versions already match', async () => {
    await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), WORKFLOW('v7'));

    const changes = await githubActionsHandler.check(dir, { 'actions/checkout': 'v7' });
    expect(changes).toHaveLength(0);
  });

  it('check: does not write files', async () => {
    const wfPath = join(dir, '.github', 'workflows', 'ci.yml');
    const original = WORKFLOW('v4');
    await writeFile(wfPath, original);

    await githubActionsHandler.check(dir, { 'actions/checkout': 'v7' });

    expect(await readFile(wfPath, 'utf-8')).toBe(original);
  });

  it('fix: rewrites action versions in workflow files', async () => {
    const wfPath = join(dir, '.github', 'workflows', 'ci.yml');
    await writeFile(wfPath, WORKFLOW('v4'));

    const changes = await githubActionsHandler.fix(dir, { 'actions/checkout': 'v7', 'actions/setup-node': 'v6' });

    expect(changes).toHaveLength(2);
    const updated = await readFile(wfPath, 'utf-8');
    expect(updated).toContain('actions/checkout@v7');
    expect(updated).toContain('actions/setup-node@v6');
  });

  it('fix: handles action.yml files', async () => {
    const actionPath = join(dir, 'action.yml');
    await writeFile(actionPath, `
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`);

    const changes = await githubActionsHandler.fix(dir, { 'actions/setup-node': 'v6' });

    expect(changes).toHaveLength(1);
    expect(await readFile(actionPath, 'utf-8')).toContain('actions/setup-node@v6');
  });
});
