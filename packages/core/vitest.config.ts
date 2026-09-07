import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const gitSrcDir = fileURLToPath(new URL('../git/src', import.meta.url));

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

// The compatibility exports in core's git folder target the sibling
// workspace package. Resolve that package to source too: Vitest externalizes
// workspace imports before Vite's export conditions can help when the sibling
// has not been built yet.
const gitWorkspaceResolver = {
  name: 'git-workspace-source-resolver',
  resolveId(id: string) {
    if (id === '@agor/git') return path.join(gitSrcDir, 'index.ts');
    if (id === '@agor/git/pure') return path.join(gitSrcDir, 'pure.ts');
    return null;
  },
};

export default defineConfig({
  plugins: [selfImportResolver, gitWorkspaceResolver],
  // Workspace dependencies expose their TypeScript implementation through
  // the `source` condition. Tests must not depend on prebuilt sibling dist
  // directories being present in a fresh worktree.
  resolve: { conditions: ['source'] },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    setupFiles: ['../../test/isolate-host-env.ts'],
  },
});
