import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    daemon: 'src/daemon.ts',
    ui: 'src/ui.ts',
    'opencode/shared/index': 'opencode/shared/index.ts',
    'opencode/runtime/index': 'opencode/runtime/index.ts',
    'opencode/ui/index': 'opencode/ui/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  splitting: false,
  shims: true,
  external: [
    '@agor/core',
    '@agor/core/client',
    '@agor/core/config',
    '@agor/core/feathers',
    '@agor/core/models',
    '@agor/core/types',
    '@ant-design/icons',
    'antd',
    'react',
    'react/jsx-runtime',
  ],
});
