import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@agor/agentic-tool-opencode', '@agor/core', /^@agor\/core\//],
});
