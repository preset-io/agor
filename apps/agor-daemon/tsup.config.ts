import { glob } from 'glob';
import { defineConfig } from 'tsup';

// Shared test fixtures are not runtime entrypoints either: bundling one can
// pull the whole service/hook graph into an otherwise unused release file.
const srcFiles = glob.sync('src/**/*.ts', {
  ignore: ['**/*.test.ts', '**/*.spec.ts', '**/*.test-fixtures.ts'],
});

// Create entry points
const entries = Object.fromEntries(
  srcFiles.map((file) => [file.replace(/^src\//, '').replace(/\.ts$/, ''), file])
);

export default defineConfig({
  entry: entries,
  format: ['esm'],
  dts: false,
  clean: true,
  // Every source file is an entry, so without splitting each one inlines its
  // whole import graph (bundled deps included) — 40+ MiB of duplicates in
  // agor-live. Splitting hoists shared code into chunks loaded once, which also
  // keeps one module instance per process across dynamic imports.
  // Caveat: esbuild can't resolve names through `export * from '<external>'`
  // when splitting; import from the external package directly instead.
  splitting: true,
  outDir: 'dist',
  // Bundle pure-JS feature trees that otherwise add many tiny packages to the
  // global install. Native and platform-selected dependencies stay external.
  noExternal: [
    /^@anthropic-ai\/sdk$/,
    /^@aws-sdk\/(client-s3|lib-storage)$/,
    /^@octokit\/(auth-app|rest)$/,
    /^(mdast-util-gfm|mdast-util-to-markdown|remark-gfm|remark-parse|unified)$/,
  ],
  external: [/^@agor\/core/, '@cursor/sdk'],
});
