import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const coreSrcDir = fileURLToPath(new URL('../core/src', import.meta.url));

const coreImportResolver = {
  name: 'executor-core-import-resolver',
  resolveId(id: string) {
    const match = id.match(/^@agor\/core(?:\/(.+))?$/);
    if (!match) return null;

    const subpath = match[1] ?? 'index';
    const indexTs = path.join(coreSrcDir, subpath, 'index.ts');
    if (existsSync(indexTs)) return indexTs;

    const directTs = path.join(coreSrcDir, `${subpath}.ts`);
    if (existsSync(directTs)) return directTs;

    return null;
  },
};

export default defineConfig({
  plugins: [coreImportResolver],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'test/**'],
  },
});
