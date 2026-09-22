import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { DevLinkConfig, DevLinkPackageOptions } from './types.js';

/** Default config location, alongside the repo's other tooling config. */
export const DEFAULT_CONFIG_PATH = '.publish/dev-local.yml';

/**
 * A `packages` entry is either the checkout path (the common form) or an
 * object carrying per-package peer options:
 *
 * ```yaml
 * peers: true                                  # default; false disables peer linking
 * packages:
 *   '@cpdevtools/git-flow': ../git-flow/packages/git-flow
 *   '@org/ng-client':
 *     path: ../webservice/.clients/ng/dist
 *     shared: ['rxjs']                         # treat like declared peers
 * ```
 */
type RawEntry = string | ({ path?: unknown } & Record<string, unknown>);

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

  const parsed = parseYaml(raw) as { packages?: unknown; peers?: unknown } | null;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.packages ||
    typeof parsed.packages !== 'object' ||
    Object.keys(parsed.packages).length === 0
  ) {
    return null;
  }

  if (parsed.peers !== undefined && typeof parsed.peers !== 'boolean') {
    throw new Error(`${file}: peers must be true or false`);
  }

  const packages: Record<string, string> = {};
  const packageOptions: Record<string, DevLinkPackageOptions> = {};

  for (const [pkg, entry] of Object.entries(parsed.packages as Record<string, RawEntry>)) {
    if (typeof entry === 'string') {
      if (entry.length === 0) throw new Error(`${file}: packages['${pkg}'] must be a non-empty path string`);
      packages[pkg] = entry;
      continue;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error(`${file}: packages['${pkg}'] must be a non-empty path string or { path, peers?, shared? }`);
    }
    packages[pkg] = entry.path;
    const options: DevLinkPackageOptions = {};
    if (entry['peers'] !== undefined) {
      if (typeof entry['peers'] !== 'boolean') throw new Error(`${file}: packages['${pkg}'].peers must be true or false`);
      options.peers = entry['peers'];
    }
    if (entry['shared'] !== undefined) {
      const shared = entry['shared'];
      if (!Array.isArray(shared) || shared.some((s) => typeof s !== 'string' || s.length === 0)) {
        throw new Error(`${file}: packages['${pkg}'].shared must be a list of package names`);
      }
      options.shared = shared as string[];
    }
    if (Object.keys(options).length > 0) packageOptions[pkg] = options;
  }

  const config: DevLinkConfig = { packages };
  if (parsed.peers !== undefined) config.peers = parsed.peers;
  if (Object.keys(packageOptions).length > 0) config.packageOptions = packageOptions;
  return config;
}
