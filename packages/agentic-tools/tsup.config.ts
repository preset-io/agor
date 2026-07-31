import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    ui: 'src/ui.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  splitting: false,
  shims: true,
  external: [
    '@agor/agentic-tool-opencode',
    '@agor/agentic-tool-opencode/ui',
    '@agor/core',
    '@agor/core/client',
    '@agor/core/config',
    '@agor/core/feathers',
    '@agor/core/models',
    '@agor/core/types',
    'react',
    'react/jsx-runtime',
  ],
});
