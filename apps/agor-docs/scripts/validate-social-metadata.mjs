import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SITE_URL = 'https://agor.live';
const DEFAULT_SOCIAL_IMAGE = '/hero.png';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '..');
const pagesDir = path.join(appDir, 'pages');
const publicDir = path.join(appDir, 'public');
const imageFields = ['ogImage', 'socialImage', 'heroImage', 'image'];

function getSiteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

function getBasePath() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
  return basePath ? `/${basePath.replace(/^\/+|\/+$/g, '')}` : '';
}

function withBasePath(pathname) {
  const basePath = getBasePath();

  if (!basePath || pathname === basePath || pathname.startsWith(`${basePath}/`)) {
    return pathname;
  }

  return `${basePath}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(value);
}

function toAbsoluteUrl(value) {
  if (isAbsoluteUrl(value)) {
    return value;
  }

  const pathname = value.startsWith('/') ? value : `/${value}`;
  return `${getSiteUrl()}${withBasePath(pathname)}`;
}

function getSocialImage(frontMatter) {
  return toAbsoluteUrl(
    frontMatter.ogImage ||
      frontMatter.socialImage ||
      frontMatter.heroImage ||
      frontMatter.image ||
      DEFAULT_SOCIAL_IMAGE
  );
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    return statSync(fullPath).isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function parseFrontMatter(filePath) {
  const source = readFileSync(filePath, 'utf8');

  if (!source.startsWith('---\n')) {
    return {};
  }

  const end = source.indexOf('\n---', 4);

  if (end === -1) {
    return {};
  }

  const frontMatter = {};

  for (const line of source.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    frontMatter[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }

  return frontMatter;
}

function assertLocalPublicImageExists(value, filePath, errors) {
  if (!value || isAbsoluteUrl(value)) {
    return;
  }

  if (!value.startsWith('/')) {
    errors.push(`${filePath}: social image paths should start with "/": ${value}`);
    return;
  }

  const publicPath = path.join(publicDir, value);

  if (!existsSync(publicPath)) {
    errors.push(`${filePath}: image does not exist under public/: ${value}`);
  }
}

const pages = walk(pagesDir)
  .filter((filePath) => filePath.endsWith('.mdx'))
  .map((filePath) => ({
    filePath: path.relative(appDir, filePath),
    frontMatter: parseFrontMatter(filePath),
  }));

const errors = [];

assertLocalPublicImageExists(DEFAULT_SOCIAL_IMAGE, 'default social image', errors);

for (const page of pages) {
  const socialImage = getSocialImage(page.frontMatter);

  if (!isAbsoluteUrl(socialImage)) {
    errors.push(`${page.filePath}: generated social image is not absolute: ${socialImage}`);
  }

  for (const field of imageFields) {
    const value = page.frontMatter[field];

    if (typeof value === 'string') {
      assertLocalPublicImageExists(value, page.filePath, errors);
    }
  }
}

if (errors.length > 0) {
  console.error(`Social metadata validation failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Validated social metadata for ${pages.length} MDX pages.`);
