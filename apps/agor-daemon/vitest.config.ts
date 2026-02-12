import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'src/auth-jwt-integration.test.ts', 'test/**'],
  },
});
