import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
  },
  format: ['cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  bundle: true,
  noExternal: [/^(?!node:).*/],
  target: 'node24',
  platform: 'node',
});
