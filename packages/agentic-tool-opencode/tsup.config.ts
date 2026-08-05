import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'shared/index': 'src/shared/index.ts',
    'daemon/index': 'src/daemon/index.ts',
    'runtime/index': 'src/runtime/index.ts',
    'runtime/binary': 'src/runtime/binary.ts',
    'ui/index': 'src/ui/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  splitting: false,
  clean: process.env.TSUP_CLEAN !== 'false',
  shims: true,
  external: [
    '@agor/core',
    '@agor/core/client',
    '@agor/core/config',
    '@agor/core/feathers',
    '@agor/core/models',
    '@agor/core/types',
    '@opencode-ai/sdk',
    '@opencode-ai/sdk/v2',
    '@ant-design/icons',
    'antd',
    'react',
    'react/jsx-runtime',
    'opencode-ai',
    'zod',
  ],
});
