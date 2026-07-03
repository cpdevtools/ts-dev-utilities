import { readFile, writeFile } from 'node:fs/promises';
import { globby } from 'globby';
import type { DepChange, DepVersionHandler } from '../types.js';

const GLOB_PATTERNS = [
  '**/Dockerfile',
  '**/Dockerfile.*',
  '**/docker-compose.yml',
  '**/docker-compose.yaml',
  '**/docker-compose.*.yml',
  '**/docker-compose.*.yaml',
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

    for (const [imageName, targetTag] of Object.entries(deps)) {
      const esc = escapeRegex(imageName);

      // FROM image:tag [AS alias]
      const fromRegex = new RegExp(`(FROM\\s+${esc}):([^\\s@"']+)`, 'gi');
      // image: image:tag   (docker-compose)
      const imageRegex = new RegExp(`(image:\\s+["']?${esc}):([^\\s"'#]+)`, 'gi');

      for (const regex of [fromRegex, imageRegex]) {
        content = content.replace(regex, (match, prefix, currentTag) => {
          if (currentTag === targetTag) return match;
          fileChanges.push({ file, name: imageName, from: currentTag, to: targetTag });
          return write ? `${prefix}:${targetTag}` : match;
        });
      }
    }

    // Deduplicate (same name/from/to in one file reported once)
    const seen = new Set<string>();
    for (const c of fileChanges) {
      const key = `${c.name}:${c.from}:${c.to}`;
      if (!seen.has(key)) {
        seen.add(key);
        allChanges.push(c);
      }
    }

    if (write && fileChanges.length > 0) {
      await writeFile(file, content);
    }
  }

  return allChanges;
}

export const dockerHandler: DepVersionHandler = {
  name: 'docker',
  check: (cwd, deps) => scan(cwd, deps, false),
  fix:   (cwd, deps) => scan(cwd, deps, true),
};
