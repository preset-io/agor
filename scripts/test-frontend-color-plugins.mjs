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

const tsxSource = `
const token = { colorText: 'from-theme' };
export const valid = { color: token.colorText, issue: 'repo#123' };
export const exact = { color: '#ffffff' };
export const compound = { background: 'linear-gradient(#000000, #ffffff)' };
export const palette = ['rgb(1, 2, 3)'];
`;

const cssSource = `
.valid { color: var(--ant-color-text); background: transparent; }
.hex { color: #ffffff; }
.functional { border-color: rgba(1, 2, 3, 0.5); }
`;

try {
  await fs.writeFile(tsxFixture, tsxSource);
  await fs.writeFile(cssFixture, cssSource);
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
    ],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const diagnostics = report.diagnostics.filter(
    (diagnostic) => diagnostic.category === 'plugin' && /Ant Design/.test(diagnostic.message)
  );
  assert.equal(diagnostics.length, 5, JSON.stringify(diagnostics, null, 2));
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.location.path.endsWith('.tsx')).length,
    3
  );
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.location.path.endsWith('.css')).length,
    2
  );
  console.log('Frontend color plugins detected all fixture violations without false positives.');
} finally {
  await Promise.all([fs.rm(tsxFixture, { force: true }), fs.rm(cssFixture, { force: true })]);
}
