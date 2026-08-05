import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', ui: 'src/ui.ts' },
  format: ['esm', 'cjs'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: process.env.TSUP_CLEAN !== 'false',
  external: [
    '@agor/agentic-tool-opencode',
    /^@agor\/agentic-tool-opencode\//,
    '@agor/core',
    /^@agor\/core\//,
    'react',
  ],
});
