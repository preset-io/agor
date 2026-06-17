import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SOCIAL_IMAGE,
  FAVICON_PATH,
  type FrontMatterLike,
  getSocialImage,
  isAbsoluteUrl,
  LOGO_PATH,
  SOCIAL_IMAGE_FIELDS,
} from '../lib/siteMetadata';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '..');
const pagesDir = path.join(appDir, 'pages');
const publicDir = path.join(appDir, 'public');

type PageMetadata = {
  filePath: string;
  frontMatter: FrontMatterLike;
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    return statSync(fullPath).isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function parseFrontMatter(filePath: string): FrontMatterLike {
  const source = readFileSync(filePath, 'utf8');

  if (!source.startsWith('---\n')) {
    return {};
  }

  const end = source.indexOf('\n---', 4);

  if (end === -1) {
    return {};
  }

  const frontMatter: FrontMatterLike = {};

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

function assertLocalPublicImageExists(value: string, filePath: string, errors: string[]): void {
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

const pages: PageMetadata[] = walk(pagesDir)
  .filter((filePath) => filePath.endsWith('.mdx'))
  .map((filePath) => ({
    filePath: path.relative(appDir, filePath),
    frontMatter: parseFrontMatter(filePath),
  }));

const errors: string[] = [];

assertLocalPublicImageExists(DEFAULT_SOCIAL_IMAGE, 'default social image', errors);
assertLocalPublicImageExists(FAVICON_PATH, 'favicon (siteMetadata.FAVICON_PATH)', errors);
assertLocalPublicImageExists(LOGO_PATH, 'logo (siteMetadata.LOGO_PATH)', errors);

for (const page of pages) {
  const socialImage = getSocialImage(page.frontMatter);

  if (!isAbsoluteUrl(socialImage)) {
    errors.push(`${page.filePath}: generated social image is not absolute: ${socialImage}`);
  }

  for (const field of SOCIAL_IMAGE_FIELDS) {
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
