import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const coreSrcDir = fileURLToPath(new URL('../../packages/core/src', import.meta.url));

const coreWorkspaceImportResolver = {
  name: 'daemon-core-workspace-import-resolver',
  resolveId(id: string) {
    const match = id.match(/^@agor\/core(?:\/(.+))?$/);
    if (!match) return null;
    const subpath = match[1] ?? 'index';
    const indexTs = path.join(coreSrcDir, subpath, 'index.ts');
    if (existsSync(indexTs)) return indexTs;
    return path.join(coreSrcDir, `${subpath}.ts`);
  },
};

export default defineConfig({
  plugins: [coreWorkspaceImportResolver],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'test/**'],
  },
});
