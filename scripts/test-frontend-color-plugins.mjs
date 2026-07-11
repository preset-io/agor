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
const CSS_NAMED_COLORS =
  'aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen'.split(
    '|'
  );

const tsxCases = [
  { name: 'tokenStyle', source: 'export const tokenStyle = { color: token.colorText };' },
  {
    name: 'brandNamedVar',
    source: "export const brandNamedVar = { color: 'var(--brand-blue)' };",
  },
  {
    name: 'tokenColorMix',
    source: `export const tokenColorMix = \`color-mix(in srgb, ${tokenInterpolation} 40%, transparent)\`;`,
  },
  {
    name: 'brandNamedColorMix',
    source:
      "export const brandNamedColorMix = { color: 'color-mix(in srgb, var(--brand-blue), transparent)' };",
  },
  { name: 'issueRef', source: "export const issueRef = 'repo#123';" },
  { name: 'proseIssue', source: "export const proseIssue = 'Fixes #123456';" },
  { name: 'svgFragment', source: "export const svgFragment = { filter: 'url(#abcdef)' };" },
  { name: 'namedSvgFragment', source: "export const namedSvgFragment = { filter: 'url(#red)' };" },
  {
    name: 'quotedSvgFragment',
    source: 'export const quotedSvgFragment = { filter: \'url("#abcdef")\' };',
  },
  {
    name: 'spacedSvgFragment',
    source: "export const spacedSvgFragment = { filter: 'url( #abcdef)' };",
  },
  {
    name: 'assetUrl',
    source: "export const assetUrl = { backgroundImage: 'url(/assets/white-logo.svg)' };",
  },
  {
    name: 'assetPath',
    source: "export const assetPath = { backgroundImage: '/assets/white-logo.svg' };",
  },
  {
    name: 'externalFragment',
    source:
      "export const externalFragment = { backgroundImage: 'url(https://cdn.test/white.svg#abcdef)' };",
  },
  {
    name: 'encodedAssetPath',
    source: "export const encodedAssetPath = { backgroundImage: 'url(sprite.svg%23abcdef)' };",
  },
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
    name: 'colorMix',
    source: "export const colorMix = 'color-mix(in srgb, red, blue)';",
    violation: true,
  },
  { name: 'hwbColor', source: "export const hwbColor = 'hwb(120 0% 0%)';", violation: true },
  { name: 'labColor', source: "export const labColor = 'lab(50% 20 30)';", violation: true },
  { name: 'lchColor', source: "export const lchColor = 'lch(50% 40 30)';", violation: true },
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
    name: 'spacedCssVar',
    source: "export const spacedCssVar = 'var( --ant-color-text)';",
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
    name: 'generatedNamedCss',
    source: 'export const generatedNamedCss = \'<span style="color:red">x</span>\';',
    violation: true,
  },
  {
    name: 'generatedBoxShadow',
    source: 'export const generatedBoxShadow = \'<span style="box-shadow:0 0 2px red">x</span>\';',
    violation: true,
  },
  {
    name: 'generatedTextShadow',
    source:
      'export const generatedTextShadow = \'<span style="text-shadow:0 0 2px blue">x</span>\';',
    violation: true,
  },
  {
    name: 'encodedSvg',
    source: "export const encodedSvg = 'data:image/svg+xml,fill=%231677ff';",
    violation: true,
  },
  {
    name: 'quotedEncodedSvg',
    source: `export const quotedEncodedSvg = "data:image/svg+xml,<svg fill='%23fff'>";`,
    violation: true,
  },
  ...CSS_NAMED_COLORS.map((name) => ({
    name: `cssName_${name}`,
    source: `export const cssName_${name} = { color: '${name}' };`,
    violation: true,
  })),
];

const cssCases = [
  { name: 'token', source: '.case-token { color: var(--ant-color-text); }' },
  { name: 'brand-named-var', source: '.case-brand-named-var { color: var(--brand-blue); }' },
  {
    name: 'token-color-mix',
    source:
      '.case-token-color-mix { color: color-mix(in srgb, var(--ant-color-text), transparent); }',
  },
  {
    name: 'brand-named-color-mix',
    source:
      '.case-brand-named-color-mix { color: color-mix(in srgb, var(--brand-blue), transparent); }',
  },
  { name: 'transparent', source: '.case-transparent { background: transparent; }' },
  { name: 'fragment', source: '.case-fragment { filter: url(#abcdef); }' },
  { name: 'named-fragment', source: '.case-named-fragment { filter: url(#red); }' },
  { name: 'quoted-fragment', source: '.case-quoted-fragment { filter: url("#abcdef"); }' },
  { name: 'spaced-fragment', source: '.case-spaced-fragment { filter: url( #abcdef); }' },
  {
    name: 'asset-url',
    source: ".case-asset-url { background: url('/assets/white-logo.svg'); }",
  },
  {
    name: 'external-fragment',
    source: '.case-external-fragment { background: url(https://cdn.test/white.svg#abcdef); }',
  },
  {
    name: 'encoded-asset-path',
    source: '.case-encoded-asset-path { background: url(sprite.svg%23abcdef); }',
  },
  { name: 'hex', source: '.case-hex { color: #ffffff; }', violation: true },
  {
    name: 'functional',
    source: '.case-functional { border-color: rgba(1, 2, 3, 0.5); }',
    violation: true,
  },
  { name: 'hwb', source: '.case-hwb { color: hwb(120 0% 0%); }', violation: true },
  { name: 'lab', source: '.case-lab { color: lab(50% 20 30); }', violation: true },
  { name: 'lch', source: '.case-lch { color: lch(50% 40 30); }', violation: true },
  {
    name: 'color-mix',
    source: '.case-color-mix { color: color-mix(in srgb, red, blue); }',
    violation: true,
  },
  {
    name: 'box-shadow-named',
    source: '.case-box-shadow-named { box-shadow: 0 0 2px red; }',
    violation: true,
  },
  {
    name: 'text-shadow-named',
    source: '.case-text-shadow-named { text-shadow: 0 0 2px blue; }',
    violation: true,
  },
  {
    name: 'drop-shadow-named',
    source: '.case-drop-shadow-named { filter: drop-shadow(0 2px 3px red); }',
    violation: true,
  },
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
  ...CSS_NAMED_COLORS.map((name) => ({
    name: `css-name-${name}`,
    source: `.case-css-name-${name} { color: ${name}; }`,
    violation: true,
  })),
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

  const actualCases = new Set(actualCounts.keys());
  const missingCases = [...expectedCases].filter((name) => !actualCases.has(name));
  const unexpectedCases = [...actualCases].filter((name) => !expectedCases.has(name));
  assert.deepEqual(
    actualCases,
    expectedCases,
    `missing=${JSON.stringify(missingCases)}; unexpected=${JSON.stringify(unexpectedCases)}`
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
