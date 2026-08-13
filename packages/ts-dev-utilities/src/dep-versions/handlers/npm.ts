import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { globby } from 'globby';
import { discoverProjects } from '../../project/discover.js';
import type { DepChange, DepVersionHandler } from '../types.js';

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * Dockerfiles under both spellings. globby is case-sensitive on Linux, so
 * `dockerfile` and `Dockerfile` have to be listed separately.
 */
const DOCKERFILE_PATTERNS = [
  '**/Dockerfile',
  '**/Dockerfile.*',
  '**/dockerfile',
  '**/dockerfile.*',
  '**/*.dockerfile',
];

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.pnpm-prod/**'];

/**
 * `workspace:`, `link:`, `file:`, `portal:`, `catalog:`, `npm:` aliases, git and
 * tarball URLs — anything carrying a protocol. These say *where a dependency
 * comes from*, not which version to take, so there is no version here to pin and
 * overwriting one with a registry range changes resolution rather than tightening
 * it. Replacing `workspace:*` in particular swaps a live workspace link for a
 * published package, so a package silently builds against its last release
 * instead of the sibling source. Plain semver ranges never contain a colon.
 */
const PROTOCOL_SPECIFIER = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Binds the next `ARG` to a package name, for the common shape where the
 * version is held in a build arg and interpolated at the install site:
 *
 * ```dockerfile
 * # dep-version: @scope/some-cli
 * ARG SOME_CLI_VERSION=1.2.3
 * RUN npm install -g "@scope/some-cli@${SOME_CLI_VERSION}"
 * ```
 *
 * The annotation is required because nothing in `ARG NAME=value` names the
 * package, and guessing from the arg name would be wrong as often as right.
 */
const ARG_ANNOTATION = /^[ \t]*#[ \t]*dep-version:[ \t]*(\S+)[ \t]*$/;
const ARG_LINE = /^([ \t]*ARG[ \t]+[A-Za-z_][A-Za-z0-9_]*=)(.+?)([ \t]*)$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripQuotes(value: string): string {
  const match = /^(["']?)(.*)\1$/.exec(value);
  return match ? (match[2] ?? value) : value;
}

/** Every package.json that should carry pinned versions, workspace root included. */
async function packageJsonPaths(cwd: string): Promise<string[]> {
  const projects = await discoverProjects({ cwd });
  const paths = projects.map((project) => project.packageJsonPath);

  // discoverProjects deliberately excludes the workspace root — it is not a
  // buildable member. But the root is where shared tooling devDependencies
  // live, so skipping it here would silently leave the toolchain unpinned.
  const root = join(cwd, 'package.json');
  if (!paths.includes(root)) {
    try {
      await readFile(root, 'utf-8');
      paths.unshift(root);
    } catch {
      // No root manifest; nothing to add.
    }
  }

  return paths;
}

async function scanPackageJson(
  path: string,
  deps: Record<string, string>,
  write: boolean,
): Promise<DepChange[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return [];
  }

  const pkg = JSON.parse(raw);
  const changes: DepChange[] = [];

  for (const field of DEP_FIELDS) {
    const section = pkg[field] as Record<string, string> | undefined;
    if (!section) continue;
    for (const [name, targetVersion] of Object.entries(deps)) {
      if (!(name in section)) continue;

      const current = section[name]!;
      if (current === targetVersion || PROTOCOL_SPECIFIER.test(current)) continue;

      changes.push({ file: path, name, from: current, to: targetVersion });
      if (write) section[name] = targetVersion;
    }
  }

  if (write && changes.length > 0) {
    await writeFile(path, JSON.stringify(pkg, null, 2) + '\n');
  }

  return changes;
}

/**
 * npm packages pinned inside Dockerfiles — an annotated `ARG`, or a literal
 * `name@version` at an install site. These are the same dependency as the one
 * in package.json, so they belong to this handler rather than the docker one,
 * which is concerned with image tags.
 */
async function scanDockerfile(
  path: string,
  deps: Record<string, string>,
  write: boolean,
): Promise<DepChange[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return [];
  }

  const changes: DepChange[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length - 1; i++) {
    const annotation = ARG_ANNOTATION.exec(lines[i]!);
    if (!annotation) continue;

    const name = annotation[1]!;
    const target = deps[name];
    if (target === undefined) continue;

    const arg = ARG_LINE.exec(lines[i + 1]!);
    if (!arg) continue;

    const current = stripQuotes(arg[2]!);
    // An interpolated value is set elsewhere; rewriting it would break the build.
    if (current === target || current.includes('${')) continue;

    changes.push({ file: path, name, from: current, to: target });
    if (write) lines[i + 1] = `${arg[1]}${target}${arg[3]}`;
  }

  if (write && changes.length > 0) content = lines.join('\n');

  // Literal `name@version` install sites, e.g. `npm install -g pkg@1.2.3`.
  for (const [name, target] of Object.entries(deps)) {
    const regex = new RegExp(`(${escapeRegex(name)}@)(?!\\$)([^\\s"'\\\`\\\\]+)`, 'g');
    content = content.replace(regex, (match, prefix, current) => {
      if (current === target) return match;
      changes.push({ file: path, name, from: current, to: target });
      return write ? `${prefix}${target}` : match;
    });
  }

  if (write && changes.length > 0) {
    await writeFile(path, content);
  }

  return changes;
}

async function scan(
  cwd: string,
  deps: Record<string, string>,
  write: boolean,
): Promise<DepChange[]> {
  const changes: DepChange[] = [];

  for (const path of await packageJsonPaths(cwd)) {
    changes.push(...(await scanPackageJson(path, deps, write)));
  }

  const dockerfiles = await globby(DOCKERFILE_PATTERNS, {
    cwd,
    absolute: true,
    ignore: IGNORE,
    followSymbolicLinks: false,
  });

  for (const path of dockerfiles) {
    changes.push(...(await scanDockerfile(path, deps, write)));
  }

  return changes;
}

export const npmHandler: DepVersionHandler = {
  name: 'npm',
  check: (cwd, deps) => scan(cwd, deps, false),
  fix: (cwd, deps) => scan(cwd, deps, true),
};
