import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  treeshake: true,
  banner: {
    js: '',
  },
});
