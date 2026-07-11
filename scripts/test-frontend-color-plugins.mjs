#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureBase = path.join(root, 'apps/agor-ui/biome-plugins/colorPluginFixture');
const tsxFixture = `${fixtureBase}.tsx`;
const cssFixture = `${fixtureBase}.css`;
const firstPartyCssFixture = `${fixtureBase}.first-party.css`;

const tsxSource = `
const token = { colorText: 'from-theme' };
export const valid = { color: token.colorText, issue: 'repo#123' };
export const exact = { color: '#ffffff' };
export const compound = { background: 'linear-gradient(#000000, #ffffff)' };
export const palette = ['rgb(1, 2, 3)'];
export const shortConditional = { color: true ? '#fff' : token.colorText };
export const namedConditional = { color: true ? 'white' : token.colorText };
export const nestedFunction = {
  filter: true ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))' : undefined,
};
export const templateColor = \`\${token.colorText}, inset 0 1px rgba(1, 2, 3, 0.2)\`;
export const directCssVar = 'var(--ant-color-text)';
export const shortSvg = <path fill="#fff" />;
export const presetTag = <Tag color="blue" />;
`;

const cssSource = `
/* biome-ignore-all lint/plugin/noFirstPartyCss: color-rule fixture */
.valid { color: var(--ant-color-text); background: transparent; }
.hex { color: #ffffff; }
.functional { border-color: rgba(1, 2, 3, 0.5); }
.named { color: white; }
`;

const firstPartyCssSource = `.new-component { display: block; }\n`;

try {
  await fs.writeFile(tsxFixture, tsxSource);
  await fs.writeFile(cssFixture, cssSource);
  await fs.writeFile(firstPartyCssFixture, firstPartyCssSource);
  const biomeBin = process.env.BIOME_BIN;
  const result = spawnSync(
    biomeBin ?? 'pnpm',
    [
      ...(biomeBin ? [] : ['exec', 'biome']),
      'lint',
      '--max-diagnostics=none',
      '--reporter=json',
      path.relative(root, tsxFixture),
      path.relative(root, cssFixture),
      path.relative(root, firstPartyCssFixture),
    ],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const diagnostics = report.diagnostics.filter(
    (diagnostic) =>
      diagnostic.category === 'plugin' && diagnostic.location.path.includes('colorPluginFixture')
  );
  assert.equal(diagnostics.length, 13, JSON.stringify(diagnostics, null, 2));
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.location.path.endsWith('.tsx')).length,
    9
  );
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.location.path.endsWith('colorPluginFixture.css'))
      .length,
    3
  );
  assert.equal(
    diagnostics.filter((diagnostic) =>
      diagnostic.location.path.endsWith('colorPluginFixture.first-party.css')
    ).length,
    1
  );
  console.log('Frontend color plugins detected all fixture violations without false positives.');
} finally {
  await Promise.all([
    fs.rm(tsxFixture, { force: true }),
    fs.rm(cssFixture, { force: true }),
    fs.rm(firstPartyCssFixture, { force: true }),
  ]);
}
