import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'project/index': 'src/project/index.ts',
    'json/index': 'src/json/index.ts',
    'artifacts/index': 'src/artifacts/index.ts',
    'runner/index': 'src/runner/index.ts',
    'dep-versions/index': 'src/dep-versions/index.ts',
    'cli/bin': 'src/cli/bin.ts',
  },
  format: ['cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  target: 'node20',
  noExternal: ['globby'],
});
