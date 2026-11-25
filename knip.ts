import type { KnipConfig } from 'knip';

// Migrated from knip.json to gain the `compilers` hook: MDX entry files
// (docs content) import components, and knip's built-in MDX compiler is
// unavailable because @mdx-js/mdx isn't hoisted. This regex compiler
// surfaces the import statements so the graph follows them.
const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: ['scripts/**/*.{ts,mjs}'],
      ignore: [],
      // The root vitest.config.ts throws on purpose (tests run per package).
      vitest: false,
    },
    'apps/agor-cli': {
      entry: ['src/index.ts', 'src/commands/**/*.ts', 'src/hooks/**/*.ts', 'src/**/*.test.ts'],
      ignore: [],
      ignoreDependencies: ['@oclif/plugin-help'],
    },
    'apps/agor-daemon': {
      entry: ['src/index.ts', 'src/**/*.test.ts'],
      ignore: [],
    },
    'apps/agor-ui': {
      entry: ['src/main.tsx', 'src/**/*.test.{ts,tsx}', 'src/test/setup.ts', 'scripts/**/*.mjs'],
      ignore: [],
      ignoreDependencies: ['@tailwindcss/cli', 'tailwindcss'],
    },
    'apps/agor-docs': {
      entry: [
        'app/**/{layout,page,not-found}.tsx',
        'app/docsTheme.tsx',
        'content/**/*.{md,mdx}',
        'content/**/_meta.ts',
        'next.config.mjs',
        'next-sitemap.config.cjs',
        'scripts/**/*.ts',
      ],
      project: ['app/**', 'components/**', 'lib/**', 'scripts/**', 'content/**'],
      ignore: ['demo-videos/**'],
      // katex and remark-mermaid are only reached through nextra's own plugins.
      ignoreDependencies: ['nextra-theme-docs', '@theguild/remark-mermaid', 'katex'],
    },
    'packages/core': {
      entry: [
        'src/index.ts',
        'src/**/*.test.ts',
        'drizzle.sqlite.config.ts',
        'drizzle.postgres.config.ts',
      ],
      ignore: ['src/db/scripts/**'],
    },
    'packages/executor': {
      entry: ['src/**/*.test.ts'],
      ignore: [],
    },
    'packages/client': {
      entry: ['src/index.ts'],
      ignore: [],
    },
  },
  compilers: {
    // Strip fenced code blocks first: docs pages are full of example
    // `import` statements that aren't real module edges.
    mdx: (text: string) =>
      [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^import[^;]+;?$/gm)]
        .map(([m]) => m)
        .join('\n'),
  },
};

export default config;
