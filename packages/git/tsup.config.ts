import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    pure: 'src/pure.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: process.env.TSUP_CLEAN !== 'false',
  splitting: false,
  shims: true,
  external: ['node:fs', 'node:fs/promises', 'node:path', 'node:os'],
});
