import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { DepChange, DepsFile } from './types.js';
import { defaultRegistry, type HandlerRegistry } from './registry.js';

async function run(
  filePath: string,
  cwd: string = process.cwd(),
  registry: HandlerRegistry = defaultRegistry,
  write: boolean,
): Promise<DepChange[]> {
  const raw = await readFile(filePath, 'utf-8');
  const depsFile = parseYaml(raw) as DepsFile | null;

  if (!depsFile || typeof depsFile !== 'object') {
    throw new Error(`${filePath} is empty or not a valid YAML object`);
  }

  const allChanges: DepChange[] = [];

  for (const [section, deps] of Object.entries(depsFile)) {
    if (!deps || typeof deps !== 'object') continue;
    const handler = registry.get(section);
    if (!handler) {
      console.warn(`dep-versions: no handler registered for section "${section}" — skipping`);
      continue;
    }
    const changes = write
      ? await handler.fix(cwd, deps as Record<string, string>)
      : await handler.check(cwd, deps as Record<string, string>);
    allChanges.push(...changes);
  }

  return allChanges;
}

/** Return all version drifts without modifying any files. */
export async function checkDepVersions(
  filePath: string,
  cwd?: string,
  registry?: HandlerRegistry,
): Promise<DepChange[]> {
  return run(filePath, cwd, registry, false);
}

/** Apply all target versions and return what was changed. */
export async function fixDepVersions(
  filePath: string,
  cwd?: string,
  registry?: HandlerRegistry,
): Promise<DepChange[]> {
  return run(filePath, cwd, registry, true);
}
