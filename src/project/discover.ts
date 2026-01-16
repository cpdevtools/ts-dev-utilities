import { globby } from 'globby';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJson } from '../json/jsonc.js';
import type { Project, ProjectDiscoveryOptions, PackageJson } from './types.js';

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
  const {
    cwd = process.cwd(),
    patterns = ['**/package.json'],
    ignore = ['**/node_modules/**', '**/dist/**'],
  } = options;

  // Find all package.json files
  const packageJsonPaths = await globby(patterns, {
    cwd,
    ignore,
    absolute: true,
    onlyFiles: true,
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
      });
    } catch (error) {
      // Skip invalid package.json files
      console.warn(`Failed to parse ${packageJsonPath}:`, error);
    }
  }

  return projects;
}
