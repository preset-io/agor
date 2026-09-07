import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const coreSrcDir = fileURLToPath(new URL('../core/src', import.meta.url));

const coreSourceResolver = {
  name: 'agentic-tool-opencode-core-source-resolver',
  resolveId(id: string) {
    const match = id.match(/^@agor\/core(?:\/(.+))?$/);
    if (!match) return null;
    const subpath = match[1] ?? 'index';
    const indexPath = path.join(coreSrcDir, subpath, 'index.ts');
    if (existsSync(indexPath)) return indexPath;
    return path.join(coreSrcDir, `${subpath}.ts`);
  },
};

export default defineConfig({
  plugins: [react(), coreSourceResolver],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['../../test/isolate-host-env.ts', './src/test/setup.ts'],
    testTimeout: 15_000,
  },
});
