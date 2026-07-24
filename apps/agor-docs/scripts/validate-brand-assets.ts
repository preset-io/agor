import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_PATH } from '../lib/siteMetadata';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(docsDir, '../..');
const canonicalLogoPath = path.join(docsDir, 'public', LOGO_PATH);
const uiLogoPath = path.join(repoDir, 'apps/agor-ui/public/logo.svg');
const appleTouchIconPath = path.join(docsDir, 'public/apple-touch-icon.png');

const errors: string[] = [];

function fail(message: string): void {
  errors.push(message);
}

if (!existsSync(canonicalLogoPath)) {
  fail(`canonical logo is missing: ${canonicalLogoPath}`);
} else {
  const svg = readFileSync(canonicalLogoPath, 'utf8');
  const rootTag = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';

  if (!/\bwidth="734"/.test(rootTag) || !/\bheight="734"/.test(rootTag)) {
    fail('canonical logo must declare 734 × 734 intrinsic dimensions');
  }
  if (!/\bviewBox="0 0 734 734"/.test(rootTag)) {
    fail('canonical logo must retain its square "0 0 734 734" viewBox');
  }
  if (!svg.includes('<title>Agor</title>')) {
    fail('canonical logo must retain its standalone accessible title');
  }
  if (!svg.includes('fill:none')) {
    fail('canonical logo must retain its transparent outer canvas');
  }
  if (!svg.includes('rgb(26,32,42)') || !svg.includes('rgb(54,183,175)')) {
    fail('canonical logo must retain its fixed dark and teal brand fills');
  }
  if (svg.includes('currentColor')) {
    fail('canonical logo must not inherit theme text color');
  }

  if (!existsSync(uiLogoPath)) {
    fail(`agor-ui deployment copy is missing: ${uiLogoPath}`);
  } else if (!readFileSync(uiLogoPath).equals(readFileSync(canonicalLogoPath))) {
    fail('agor-ui public/logo.svg must be byte-identical to the canonical docs logo.svg');
  }
}

if (!existsSync(appleTouchIconPath)) {
  fail(`Apple touch icon is missing: ${appleTouchIconPath}`);
} else {
  const png = readFileSync(appleTouchIconPath);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  if (png.length < 26 || !png.subarray(0, 8).equals(pngSignature)) {
    fail('Apple touch icon must be a valid PNG');
  } else {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const colorType = png[25];

    if (width !== 180 || height !== 180) {
      fail(`Apple touch icon must be 180 × 180, found ${width} × ${height}`);
    }
    if (colorType !== 4 && colorType !== 6) {
      fail('Apple touch icon must retain an alpha channel for the transparent outer canvas');
    }
  }
}

const retiredAssets = [
  '.github/logo.png',
  '.github/logo_circle.png',
  'apps/agor-docs/public/favicon.png',
  'apps/agor-docs/public/logo-mark.svg',
  'apps/agor-docs/public/logo.png',
  'apps/agor-ui/public/favicon.png',
];

for (const asset of retiredAssets) {
  if (existsSync(path.join(repoDir, asset))) {
    fail(`retired logo asset still exists: ${asset}`);
  }
}

if (errors.length > 0) {
  console.error(`Brand asset validation failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Validated the canonical SVG, UI deployment copy, and Apple touch raster.');
