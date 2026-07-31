import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'shared/index': 'src/shared/index.ts',
    'daemon/index': 'src/daemon/index.ts',
    'runtime/index': 'src/runtime/index.ts',
    'ui/index': 'src/ui/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: process.env.TSUP_CLEAN !== 'false',
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
    '@opencode-ai/sdk',
    '@opencode-ai/sdk/v2',
    'antd',
    'opencode-ai',
    'react',
    'react/jsx-runtime',
    'zod',
  ],
});
