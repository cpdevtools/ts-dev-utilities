import { readFile, writeFile } from 'node:fs/promises';
import { globby } from 'globby';
import type { DepChange, DepVersionHandler } from '../types.js';

const GLOB_PATTERNS = [
  '.github/workflows/**/*.yml',
  '.github/workflows/**/*.yaml',
  '**/action.yml',
  '**/action.yaml',
];
const IGNORE = ['**/node_modules/**'];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function scan(cwd: string, deps: Record<string, string>, write: boolean): Promise<DepChange[]> {
  const files = await globby(GLOB_PATTERNS, { cwd, absolute: true, ignore: IGNORE, followSymbolicLinks: false });
  const allChanges: DepChange[] = [];

  for (const file of files) {
    let content = await readFile(file, 'utf-8');
    const fileChanges: DepChange[] = [];

    for (const [actionName, targetVersion] of Object.entries(deps)) {
      const esc = escapeRegex(actionName);
      // Matches:  uses: owner/repo@vX  (with optional leading whitespace / quotes)
      const regex = new RegExp(`(uses:\\s+["']?${esc})@([^\\s"'#]+)`, 'g');

      content = content.replace(regex, (match, prefix, currentVersion) => {
        if (currentVersion === targetVersion) return match;
        fileChanges.push({ file, name: actionName, from: currentVersion, to: targetVersion });
        return write ? `${prefix}@${targetVersion}` : match;
      });
    }

    if (write && fileChanges.length > 0) {
      await writeFile(file, content);
    }

    allChanges.push(...fileChanges);
  }

  return allChanges;
}

export const githubActionsHandler: DepVersionHandler = {
  name: 'github-actions',
  check: (cwd, deps) => scan(cwd, deps, false),
  fix:   (cwd, deps) => scan(cwd, deps, true),
};
