import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'shared/index': 'src/shared/index.ts',
    'runtime/index': 'src/runtime/index.ts',
    'ui/index': 'src/ui/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    '@agor/core',
    /^@agor\/core\//,
    '@opencode-ai/sdk',
    '@ant-design/icons',
    'antd',
    'react',
    'react/jsx-runtime',
  ],
});
