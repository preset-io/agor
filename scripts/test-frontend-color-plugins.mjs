#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureId = `${process.pid}-${randomUUID()}`;
const fixtureStem = `colorPluginFixture-${fixtureId}`;
const fixtureBase = path.join(root, 'apps/agor-ui/biome-plugins', fixtureStem);
const tsxFixture = `${fixtureBase}.tsx`;
const cssFixture = `${fixtureBase}.css`;
const firstPartyCssFixture = `${fixtureBase}.first-party.css`;
const tokenInterpolation = '$' + '{token.colorText}';

const tsxCases = [
  { name: 'tokenStyle', source: 'export const tokenStyle = { color: token.colorText };' },
  { name: 'issueRef', source: "export const issueRef = 'repo#123';" },
  { name: 'proseIssue', source: "export const proseIssue = 'Fixes #123456';" },
  { name: 'svgFragment', source: "export const svgFragment = { filter: 'url(#abcdef)' };" },
  { name: 'transparent', source: "export const transparent = { background: 'transparent' };" },
  { name: 'presetTag', source: 'export const presetTag = <Tag color="blue" />;' },
  {
    name: 'exactHex',
    source: "export const exactHex = { color: '#ffffff' };",
    violation: true,
  },
  {
    name: 'compoundHex',
    source: "export const compoundHex = { border: '1px solid #fff' };",
    violation: true,
  },
  {
    name: 'paletteFunction',
    source: "export const paletteFunction = ['rgb(1, 2, 3)'];",
    violation: true,
  },
  {
    name: 'shortConditional',
    source: "export const shortConditional = { color: true ? '#fff' : token.colorText };",
    violation: true,
  },
  {
    name: 'namedConditional',
    source: "export const namedConditional = { color: true ? 'white' : token.colorText };",
    violation: true,
  },
  {
    name: 'namedCompound',
    source: "export const namedCompound = { border: '1px solid red' };",
    violation: true,
  },
  {
    name: 'namedGradient',
    source: "export const namedGradient = { backgroundImage: 'linear-gradient(white, black)' };",
    violation: true,
  },
  {
    name: 'namedTeal',
    source: "export const namedTeal = { color: 'teal' };",
    violation: true,
  },
  {
    name: 'nestedFunction',
    source:
      "export const nestedFunction = { filter: true ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))' : undefined };",
    violation: true,
  },
  {
    name: 'templateColor',
    source: `export const templateColor = \`${tokenInterpolation}, inset 0 1px rgba(1, 2, 3, 0.2)\`;`,
    violation: true,
  },
  {
    name: 'directCssVar',
    source: "export const directCssVar = 'var(--ant-color-text)';",
    violation: true,
  },
  {
    name: 'shortSvg',
    source: 'export const shortSvg = <path fill="#fff" />;',
    violation: true,
  },
  {
    name: 'generatedCss',
    source: 'export const generatedCss = \'<span style="background:#abcdef">x</span>\';',
    violation: true,
  },
  {
    name: 'encodedSvg',
    source: "export const encodedSvg = 'data:image/svg+xml,fill=%231677ff';",
    violation: true,
  },
];

const cssCases = [
  { name: 'token', source: '.case-token { color: var(--ant-color-text); }' },
  { name: 'transparent', source: '.case-transparent { background: transparent; }' },
  { name: 'fragment', source: '.case-fragment { filter: url(#abcdef); }' },
  { name: 'hex', source: '.case-hex { color: #ffffff; }', violation: true },
  {
    name: 'functional',
    source: '.case-functional { border-color: rgba(1, 2, 3, 0.5); }',
    violation: true,
  },
  { name: 'named-teal', source: '.case-named-teal { color: teal; }', violation: true },
  {
    name: 'encoded-svg',
    source: `.case-encoded-svg { cursor: url("data:image/svg+xml,<svg fill='%231677ff'></svg>"), pointer; }`,
    violation: true,
  },
  {
    name: 'data-svg',
    source: `.case-data-svg { cursor: url("data:image/svg+xml,<svg fill='#fff'></svg>"), pointer; }`,
    violation: true,
  },
];

const tsxSource = [
  "const token = { colorText: 'from-theme' };",
  ...tsxCases.map((c) => c.source),
].join('\n');
const cssSource = [
  '/* biome-ignore-all lint/plugin/noFirstPartyCss: color-rule fixture */',
  ...cssCases.map((c) => c.source),
].join('\n');
const firstPartyCssSource = `.new-component { display: block; }\n`;

const expectedCases = new Set([
  ...tsxCases.filter((c) => c.violation).map((c) => `tsx:${c.name}`),
  ...cssCases.filter((c) => c.violation).map((c) => `css:${c.name}`),
  'css:first-party',
]);

function diagnosticCase(diagnostic) {
  const fixturePath = diagnostic.location.path;
  const line = diagnostic.location.start.line;
  if (fixturePath.endsWith('.first-party.css')) return 'css:first-party';
  if (fixturePath.endsWith('.tsx')) {
    const sourceLine = tsxSource.split('\n')[line - 1] ?? '';
    const name = sourceLine.match(/export const ([A-Za-z0-9_]+)/)?.[1];
    return name ? `tsx:${name}` : `tsx:unknown-line-${line}`;
  }
  const sourceLine = cssSource.split('\n')[line - 1] ?? '';
  const name = sourceLine.match(/\.case-([a-z0-9-]+)/)?.[1];
  return name ? `css:${name}` : `css:unknown-line-${line}`;
}

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
      diagnostic.category === 'plugin' && diagnostic.location.path.includes(fixtureStem)
  );
  const actualCounts = new Map();
  for (const diagnostic of diagnostics) {
    const name = diagnosticCase(diagnostic);
    actualCounts.set(name, (actualCounts.get(name) ?? 0) + 1);
  }

  assert.deepEqual(
    new Set(actualCounts.keys()),
    expectedCases,
    JSON.stringify(diagnostics, null, 2)
  );
  for (const name of expectedCases) {
    assert.equal(actualCounts.get(name), 1, `${name} should produce exactly one diagnostic`);
  }
  console.log(`Frontend design-system plugins passed ${expectedCases.size} named fixture cases.`);
} finally {
  await Promise.all([
    fs.rm(tsxFixture, { force: true }),
    fs.rm(cssFixture, { force: true }),
    fs.rm(firstPartyCssFixture, { force: true }),
  ]);
}
