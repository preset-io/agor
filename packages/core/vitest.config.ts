import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

// pnpm does not self-link a workspace package into its own node_modules, so
// `@agor/core/*` imports from within this package can't go through the
// exports map. This plugin intercepts them and maps to src/ directly.
const selfImportResolver = {
  name: 'core-self-import-resolver',
  resolveId(id: string) {
    const m = id.match(/^@agor\/core(?:\/(.+))?$/);
    if (!m) return null;
    const sub = m[1] ?? 'index';
    const indexTs = path.join(srcDir, sub, 'index.ts');
    if (existsSync(indexTs)) return indexTs;
    return path.join(srcDir, `${sub}.ts`);
  },
};

export default defineConfig({
  plugins: [selfImportResolver],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
});
