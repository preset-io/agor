/**
 * Guards the Streamdown theming contract.
 *
 * Streamdown's supported styling is "the host app compiles our Tailwind
 * utility classes". Agor compiles them at development time into
 * streamdown-tailwind.generated.css with shadcn tokens bridged to Ant Design
 * CSS variables (see streamdown-theme.css). These tests fail when:
 *  - the streamdown dist (version bump or pnpm patch) or the theme bridge
 *    changes without regenerating (`pnpm --filter agor-ui gen:streamdown-css`)
 *  - the token bridge stops resolving colors to --ant-* variables
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const streamdownRoot = path.dirname(require.resolve('streamdown/styles.css'));

const themeCssPath = 'src/components/MarkdownRenderer/streamdown-theme.css';
const generatedCss = readFileSync(
  'src/components/MarkdownRenderer/streamdown-tailwind.generated.css',
  'utf8'
);

// Mirrors computeSourceHash in scripts/gen-streamdown-css.mjs; the stamp
// equality assertion below keeps the two implementations honest.
function computeSourceHash(): string {
  const distDir = path.join(streamdownRoot, 'dist');
  const hash = createHash('sha256');
  hash.update(readFileSync(themeCssPath));
  for (const file of readdirSync(distDir).sort()) {
    if (!file.endsWith('.js')) continue;
    hash.update(file);
    hash.update(readFileSync(path.join(distDir, file)));
  }
  return hash.digest('hex');
}

describe('streamdown-tailwind.generated.css', () => {
  it('stays in sync with the installed streamdown dist and theme bridge', () => {
    const stamp = generatedCss.match(/source-hash: ([0-9a-f]{64}) \(streamdown@([^)]+)\)/);
    expect(stamp, 'generated file is missing its @generated source-hash stamp').not.toBeNull();
    expect(
      stamp?.[1],
      'Streamdown inputs changed — run `pnpm --filter agor-ui gen:streamdown-css` and commit the result'
    ).toBe(computeSourceHash());
  });

  it('bridges Streamdown color utilities to Ant Design semantic tokens', () => {
    const bridges: Array<[string, string]> = [
      ['bg-background', '--ant-color-bg-container'],
      ['hover\\\\:text-foreground:hover', '--ant-color-text'],
      ['bg-muted', '--ant-color-fill-tertiary'],
      ['text-muted-foreground', '--ant-color-text-secondary'],
      ['border-border', '--ant-color-border-secondary'],
      ['bg-sidebar', '--ant-color-bg-layout'],
      ['text-primary', '--ant-color-primary'],
    ];
    for (const [utility, antVariable] of bridges) {
      const rule = new RegExp(`\\.${utility}\\s*\\{[^}]*var\\(${antVariable}\\)`);
      expect(generatedCss, `${utility} should resolve to var(${antVariable})`).toMatch(rule);
    }
  });

  it('contains no hard-coded palette colors', () => {
    // Tailwind's default palette is oklch; every color Streamdown uses must
    // route through the Ant Design variable bridge instead.
    expect(generatedCss).not.toMatch(/oklch\(/);
  });

  it('compiles the chrome utilities that regressed unstyled with streamdown 2.5', () => {
    // Link-safety modal, table/mermaid download dropdowns, and image hover
    // controls depend on these; they were absent from the former hand-rolled
    // utility subset.
    for (const selector of [
      '.fixed',
      '.absolute',
      '.sticky',
      '.z-50',
      '.shadow-lg',
      '.backdrop-blur-sm',
      '.animate-spin',
    ]) {
      expect(generatedCss).toContain(`${selector} {`);
    }
    // Dark mode variants bind to Agor's html.dark convention (ThemeContext).
    expect(generatedCss).toMatch(/\.dark\\:[^\s{]+:where\(\.dark, \.dark \*\)/);
    // The scoped preflight slice Streamdown's buttons rely on.
    expect(generatedCss).toMatch(/button:where\(\[data-streamdown\]\)/);
  });
});
