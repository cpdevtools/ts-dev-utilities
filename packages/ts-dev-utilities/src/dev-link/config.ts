import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { DevLinkConfig } from './types.js';

/** Default config location, alongside the repo's other tooling config. */
export const DEFAULT_CONFIG_PATH = '.publish/dev-local.yml';

/**
 * Loads the dev-link map. Returns null when the file doesn't exist or maps no
 * packages — "nothing configured" is a normal state, not an error.
 */
export async function loadDevLinkConfig(
  cwd: string,
  configPath?: string,
): Promise<DevLinkConfig | null> {
  const file = resolve(cwd, configPath ?? DEFAULT_CONFIG_PATH);

  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const parsed = parseYaml(raw) as Partial<DevLinkConfig> | null;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.packages ||
    typeof parsed.packages !== 'object' ||
    Object.keys(parsed.packages).length === 0
  ) {
    return null;
  }

  for (const [pkg, path] of Object.entries(parsed.packages)) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`${file}: packages['${pkg}'] must be a non-empty path string`);
    }
  }

  return { packages: parsed.packages as Record<string, string> };
}
