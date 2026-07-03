import { readFile, writeFile } from 'node:fs/promises';
import { discoverProjects } from '../../project/discover.js';
import type { DepChange, DepVersionHandler } from '../types.js';

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

async function scan(cwd: string, deps: Record<string, string>, write: boolean): Promise<DepChange[]> {
  const projects = await discoverProjects({ cwd });
  const allChanges: DepChange[] = [];

  for (const project of projects) {
    const raw = await readFile(project.packageJsonPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const fileChanges: DepChange[] = [];

    for (const field of DEP_FIELDS) {
      const section = pkg[field] as Record<string, string> | undefined;
      if (!section) continue;
      for (const [name, targetVersion] of Object.entries(deps)) {
        if (name in section && section[name] !== targetVersion) {
          fileChanges.push({ file: project.packageJsonPath, name, from: section[name], to: targetVersion });
          if (write) section[name] = targetVersion;
        }
      }
    }

    if (write && fileChanges.length > 0) {
      await writeFile(project.packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    }

    allChanges.push(...fileChanges);
  }

  return allChanges;
}

export const npmHandler: DepVersionHandler = {
  name: 'npm',
  check: (cwd, deps) => scan(cwd, deps, false),
  fix:   (cwd, deps) => scan(cwd, deps, true),
};
