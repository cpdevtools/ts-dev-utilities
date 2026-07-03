import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dotnetHandler } from './dotnet.js';

const PROPS = (version: string) => `
<Project>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="${version}" />
    <PackageVersion Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>
`;

describe('dotnetHandler', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `test-dotnet-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('check: detects outdated package version', async () => {
    await writeFile(join(dir, 'Directory.Packages.props'), PROPS('12.0.0'));

    const changes = await dotnetHandler.check(dir, { 'Newtonsoft.Json': '13.0.3' });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ name: 'Newtonsoft.Json', from: '12.0.0', to: '13.0.3' });
  });

  it('check: returns nothing when versions match', async () => {
    await writeFile(join(dir, 'Directory.Packages.props'), PROPS('13.0.3'));

    const changes = await dotnetHandler.check(dir, { 'Newtonsoft.Json': '13.0.3' });
    expect(changes).toHaveLength(0);
  });

  it('check: does not write files', async () => {
    const propsPath = join(dir, 'Directory.Packages.props');
    const original = PROPS('12.0.0');
    await writeFile(propsPath, original);

    await dotnetHandler.check(dir, { 'Newtonsoft.Json': '13.0.3' });

    expect(await readFile(propsPath, 'utf-8')).toBe(original);
  });

  it('fix: rewrites version in Directory.Packages.props', async () => {
    const propsPath = join(dir, 'Directory.Packages.props');
    await writeFile(propsPath, PROPS('12.0.0'));

    const changes = await dotnetHandler.fix(dir, { 'Newtonsoft.Json': '13.0.3' });

    expect(changes).toHaveLength(1);
    expect(await readFile(propsPath, 'utf-8')).toContain('Version="13.0.3"');
    // Unrelated package unchanged
    expect(await readFile(propsPath, 'utf-8')).toContain('Version="3.0.0"');
  });

  it('fix: rewrites PackageReference in .csproj', async () => {
    const csprojPath = join(dir, 'MyApp.csproj');
    await writeFile(csprojPath, `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="12.0.0" />
  </ItemGroup>
</Project>`);

    const changes = await dotnetHandler.fix(dir, { 'Newtonsoft.Json': '13.0.3' });

    expect(changes).toHaveLength(1);
    expect(await readFile(csprojPath, 'utf-8')).toContain('Version="13.0.3"');
  });
});
