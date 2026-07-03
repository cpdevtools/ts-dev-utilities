import { globby } from 'globby';
import { readFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseJson } from '../json/jsonc.js';
import type { Project, ProjectDiscoveryOptions, PackageJson } from './types.js';

/**
 * Derive package.json glob patterns from a `pnpm-workspace.yaml` at `cwd`.
 *
 * Member globs (e.g. `packages/*`) become `packages/*\/package.json`, which
 * scopes discovery to actual workspace members and excludes the workspace root.
 * Negated entries (`!path`) are collected as ignore patterns. Returns
 * `undefined` when no workspace file is present so callers can fall back to the
 * default recursive search.
 */
async function readWorkspacePatterns(
  cwd: string,
): Promise<{ patterns: string[]; ignore: string[] } | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, 'pnpm-workspace.yaml'), 'utf-8');
  } catch {
    return undefined;
  }

  const parsed = parseYaml(raw) as { packages?: unknown } | null;
  const entries = parsed?.packages;
  if (!Array.isArray(entries)) return undefined;

  const patterns: string[] = [];
  const ignore: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const negated = entry.startsWith('!');
    const glob = `${(negated ? entry.slice(1) : entry).replace(/\/+$/, '')}/package.json`;
    (negated ? ignore : patterns).push(glob);
  }

  return patterns.length > 0 ? { patterns, ignore } : undefined;
}

/**
 * Discover projects in a workspace by finding package.json files
 * 
 * @param options - Discovery options
 * @returns Array of discovered projects
 * 
 * @example
 * ```typescript
 * const projects = await discoverProjects({
 *   cwd: process.cwd(),
 *   patterns: ['packages/*\/package.json'],
 * });
 * ```
 */
export async function discoverProjects(
  options: ProjectDiscoveryOptions = {},
): Promise<Project[]> {
  const { cwd = process.cwd() } = options;

  // When patterns aren't explicitly provided, prefer the pnpm workspace
  // definition so discovery matches actual members and skips the root.
  const workspace = options.patterns ? undefined : await readWorkspacePatterns(cwd);

  const patterns = options.patterns ?? workspace?.patterns ?? ['**/package.json'];
  const ignore = options.ignore ?? [
    '**/node_modules/**',
    '**/dist/**',
    '**/.pnpm-prod/**',
    ...(workspace?.ignore ?? []),
  ];

  // Find all package.json files
  const packageJsonPaths = await globby(patterns, {
    cwd,
    ignore,
    absolute: true,
    onlyFiles: true,
    // Never traverse into symlinked directories — real workspace packages are
    // always real directories. Following symlinks can recurse infinitely through
    // nested package installs (e.g. .pnpm-prod symlinking back to the repo root).
    followSymbolicLinks: false,
  });

  // Read and parse each package.json
  const projects: Project[] = [];
  
  for (const packageJsonPath of packageJsonPaths) {
    try {
      const content = await readFile(packageJsonPath, 'utf-8');
      const packageJson = parseJson(content) as PackageJson;
      
      projects.push({
        packageJsonPath,
        directory: dirname(packageJsonPath),
        packageJson,
        name: packageJson.name || basename(dirname(packageJsonPath)),
        dependencies: packageJson.dependencies,
        devDependencies: packageJson.devDependencies,
      });
    } catch (error) {
      // Skip invalid package.json files
      console.warn(`Failed to parse ${packageJsonPath}: ${(error as Error).message}`);
    }
  }

  return projects;
}
