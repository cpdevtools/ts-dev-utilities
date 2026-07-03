import { readFile, writeFile } from 'node:fs/promises';
import { globby } from 'globby';
import type { DepChange, DepVersionHandler } from '../types.js';

const GLOB_PATTERNS = ['**/Directory.Packages.props', '**/*.csproj'];
const IGNORE = ['**/node_modules/**', '**/bin/**', '**/obj/**'];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites Version="..." on PackageVersion / PackageReference elements that
 * have Include="<name>". Handles both attribute orderings:
 *   Include="Name" Version="x"
 *   Version="x" Include="Name"
 */
function rewriteVersion(content: string, name: string, targetVersion: string): { content: string; changes: number } {
  const esc = escapeRegex(name);
  let changes = 0;

  // Include before Version
  const r1 = new RegExp(
    `(<(?:PackageVersion|PackageReference)[^>]*Include=["']${esc}["'][^>]*)Version=["'][^"']*["']`,
    'gi',
  );
  // Version before Include
  const r2 = new RegExp(
    `(<(?:PackageVersion|PackageReference)[^>]*)Version=["'][^"']*["']([^>]*Include=["']${esc}["'])`,
    'gi',
  );

  content = content.replace(r1, (_m, pre) => { changes++; return `${pre}Version="${targetVersion}"`; });
  content = content.replace(r2, (_m, pre, post) => { changes++; return `${pre}Version="${targetVersion}"${post}`; });

  return { content, changes };
}

async function scan(cwd: string, deps: Record<string, string>, write: boolean): Promise<DepChange[]> {
  const files = await globby(GLOB_PATTERNS, { cwd, absolute: true, ignore: IGNORE, followSymbolicLinks: false });
  const allChanges: DepChange[] = [];

  for (const file of files) {
    let content = await readFile(file, 'utf-8');
    const fileChanges: DepChange[] = [];

    for (const [name, targetVersion] of Object.entries(deps)) {
      // Find the current version before any rewrite so we can record "from"
      const esc = escapeRegex(name);
      const findCurrent = new RegExp(
        `<(?:PackageVersion|PackageReference)[^>]*Include=["']${esc}["'][^>]*Version=["']([^"']+)["']|` +
        `<(?:PackageVersion|PackageReference)[^>]*Version=["']([^"']+)["'][^>]*Include=["']${esc}["']`,
        'i',
      );
      const match = findCurrent.exec(content);
      if (!match) continue;
      const currentVersion = match[1] ?? match[2];
      if (currentVersion === targetVersion) continue;

      fileChanges.push({ file, name, from: currentVersion, to: targetVersion });

      if (write) {
        const result = rewriteVersion(content, name, targetVersion);
        content = result.content;
      }
    }

    if (write && fileChanges.length > 0) {
      await writeFile(file, content);
    }

    allChanges.push(...fileChanges);
  }

  return allChanges;
}

export const dotnetHandler: DepVersionHandler = {
  name: 'dotnet',
  check: (cwd, deps) => scan(cwd, deps, false),
  fix:   (cwd, deps) => scan(cwd, deps, true),
};
