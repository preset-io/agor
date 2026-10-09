import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['../../test/isolate-host-env.ts'],
    include: ['lib/**/*.test.ts'],
  },
});
