import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Exact-match aliases from every workspace package's exports to their `source`
 * entries. `resolve.conditions` covers the jsdom tests, but
 * `@vitest-environment node` tests resolve through SSR, and Vitest passes the
 * SSR conditions to Node as `--conditions`, which would apply `source` to
 * third-party packages too (some ship raw TypeScript under it). CI's unit
 * shards don't build workspace dist, so these tests must load source.
 */
function workspaceSourceAliases() {
  const packages = path.resolve(__dirname, '../../packages');
  return readdirSync(packages).flatMap((dir) => {
    const root = path.join(packages, dir);
    let manifest: { name: string; exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch {
      return [];
    }
    return Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
      const source = (target as { source?: string } | null)?.source;
      if (typeof source !== 'string') return [];
      const id = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      const exact = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`);
      return [{ find: exact, replacement: path.join(root, source) }];
    });
  });
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['source'],
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      ...workspaceSourceAliases(),
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['../../test/isolate-host-env.ts', './src/test/setup.ts'],
    server: {
      deps: {
        // Streamdown dynamically imports KaTeX CSS; inline both packages so
        // Vite transforms that CSS import in jsdom component tests.
        inline: ['streamdown', 'katex'],
      },
    },
    // `*.browser.test.tsx` run only under the real-browser config
    // (vitest.browser.config.ts) — they rely on true layout/scroll/stacking that
    // jsdom can't model.
    exclude: [...configDefaults.exclude, 'src/utils/theme.test.ts', 'src/**/*.browser.test.tsx'],
    // Ant Design Form / Select first-mount cost (CSS parse + JSDOM
    // getComputedStyle stubs) blows past vitest's 5s default on CI cold
    // start, even though the same test runs in <300ms warm. Bump to 15s.
    testTimeout: 15_000,
  },
});
