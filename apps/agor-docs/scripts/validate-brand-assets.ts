import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getBasePath, LOGO_MARK_PATH, LOGO_PATH } from '../lib/siteMetadata';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(docsDir, '../..');
const canonicalLogoPath = path.join(docsDir, 'public', LOGO_PATH);
const canonicalMarkPath = path.join(docsDir, 'public', LOGO_MARK_PATH);
const uiLogoPath = path.join(repoDir, 'apps/agor-ui/public/logo.svg');
const uiMarkPath = path.join(repoDir, 'apps/agor-ui/public/logo-mark.svg');
const appleTouchIconPath = path.join(docsDir, 'public/apple-touch-icon.png');

const errors: string[] = [];

function fail(message: string): void {
  errors.push(message);
}

function validateSvg(pathname: string, label: string): string | null {
  if (!existsSync(pathname)) {
    fail(`${label} is missing: ${pathname}`);
    return null;
  }

  const svg = readFileSync(pathname, 'utf8');
  const rootTag = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';

  if (!/\bwidth="734"/.test(rootTag) || !/\bheight="734"/.test(rootTag)) {
    fail(`${label} must declare 734 × 734 intrinsic dimensions`);
  }
  if (!/\bviewBox="0 0 734 734"/.test(rootTag)) {
    fail(`${label} must retain its square "0 0 734 734" viewBox`);
  }
  if (!svg.includes('<title>Agor</title>')) {
    fail(`${label} must retain its standalone accessible title`);
  }
  if (!svg.includes('fill:none')) {
    fail(`${label} must retain its transparent outer canvas`);
  }
  if (!svg.includes('rgb(54,183,175)')) {
    fail(`${label} must retain its fixed teal brand fill`);
  }
  if (svg.includes('currentColor')) {
    fail(`${label} must not inherit theme text color`);
  }

  return svg;
}

const badgeSvg = validateSvg(canonicalLogoPath, 'backed logo badge');
const markSvg = validateSvg(canonicalMarkPath, 'transparent logo mark');

if (badgeSvg && !badgeSvg.includes('rgb(26,32,42)')) {
  fail('backed logo badge must retain its fixed dark backing circle');
}
if (markSvg?.includes('rgb(26,32,42)') || markSvg?.includes('stroke:black')) {
  fail('transparent logo mark must not contain the dark backing circle or border');
}

for (const [docsAsset, uiAsset, label] of [
  [canonicalLogoPath, uiLogoPath, 'logo.svg'],
  [canonicalMarkPath, uiMarkPath, 'logo-mark.svg'],
] as const) {
  if (!existsSync(uiAsset)) {
    fail(`agor-ui deployment copy is missing: ${uiAsset}`);
  } else if (existsSync(docsAsset) && !readFileSync(uiAsset).equals(readFileSync(docsAsset))) {
    fail(`agor-ui public/${label} must be byte-identical to the docs ${label}`);
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

    // A valid IHDR does not prove the artwork is complete: the former PNG had
    // correct dimensions but fully transparent rows 93–179. Decode and compare
    // the whole image to the canonical badge, including its legitimate alpha.
    try {
      const actual = await sharp(png).ensureAlpha().raw().toBuffer();
      const expected = await sharp(canonicalLogoPath)
        .resize(180, 180)
        .ensureAlpha()
        .raw()
        .toBuffer();
      if (actual.length !== expected.length) {
        fail('Apple touch icon decoded dimensions do not match the canonical render');
      } else {
        const difference = actual.reduce(
          (sum, value, index) => sum + Math.abs(value - expected[index]),
          0
        );
        // Allow minor antialiasing differences across librsvg versions, but
        // reject clipped, stretched, recolored, or flattened artwork.
        if (difference / actual.length > 2) {
          fail('Apple touch icon must render the complete canonical badge with transparency');
        }
      }
    } catch (error) {
      fail(`Apple touch icon could not be decoded/rendered: ${String(error)}`);
    }
  }
}

// Opt in after next build: check the real exported homepage, not just source
// strings (App Router file conventions can silently introduce extra icons).
if (process.argv.includes('--export')) {
  const outDir = path.join(docsDir, 'out');
  const homepage = readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const links = [...homepage.matchAll(/<link\b[^>]*>/g)]
    .map(([tag]) =>
      Object.fromEntries(
        [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])
      )
    )
    .filter(({ rel }) => /\bicon\b|manifest/.test(rel ?? ''));
  const basePath = getBasePath();
  if (
    links.length !== 2 ||
    !links.some(
      ({ rel, type, href }) =>
        rel === 'icon' && type === 'image/svg+xml' && href === `${basePath}${LOGO_PATH}`
    ) ||
    !links.some(
      ({ rel, sizes, href }) =>
        rel === 'apple-touch-icon' &&
        sizes === '180x180' &&
        href === `${basePath}/apple-touch-icon.png`
    )
  ) {
    fail('Exported homepage must advertise only the canonical SVG and 180 × 180 Apple touch icon');
  }
  for (const filename of ['logo.svg', 'apple-touch-icon.png']) {
    if (
      !readFileSync(path.join(outDir, filename)).equals(
        readFileSync(path.join(docsDir, 'public', filename))
      )
    ) {
      fail(`Exported ${filename} differs from its validated public asset`);
    }
  }
}

const retiredAssets = [
  '.github/logo.png',
  '.github/logo_circle.png',
  'apps/agor-docs/public/favicon.png',
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

console.log('Validated the SVG mark/badge set, UI deployment copies, and Apple touch raster.');
