import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const outputDir = join(process.cwd(), 'out');
const measurementId = process.env.NEXT_PUBLIC_GA_ID;

if (!measurementId) {
  throw new Error('NEXT_PUBLIC_GA_ID is required to validate the production analytics export');
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap(function visit(entry) {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(outputDir);
const htmlFiles = files.filter(function isHtml(file) {
  return file.endsWith('.html');
});
const javascript = files
  .filter(function isJavaScript(file) {
    return file.endsWith('.js');
  })
  .map(function readJavaScript(file) {
    return readFileSync(file, 'utf8');
  })
  .join('\n');

if (htmlFiles.length === 0) throw new Error('No exported HTML files found');

// These retired ad destinations are plain redirects, not rendered pages.
// Instrumenting them would count the same visit twice. Keep the exception
// closed: a named stub must match the redirect-only document, with no tags,
// while every other HTML file still requires exactly one GA integration.
const retiredCampaigns = new Set(
  [
    'beyond-the-sandbox',
    'costs-under-control-solution',
    'costs-under-control',
    'dev-team',
    'not-alone-problem',
    'not-alone',
    'not-just-a-tool',
    'right-where-you-work',
    'selfware-is-dead',
    'team-sport',
  ].map((slug) => `${slug}/index.html`)
);
const normalizeHtml = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const redirectHtml = normalizeHtml(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="https://agor.live/" />
    <meta http-equiv="refresh" content="0; url=../" />
    <script>
      location.replace('../' + location.search + location.hash);
    </script>
    <title>agor</title>
  </head>
  <body>
    <a href="../">Continue to agor.live</a>
  </body>
</html>`);
let redirects = 0;

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  if (retiredCampaigns.has(relative(outputDir, file).split('\\').join('/'))) {
    if (normalizeHtml(html) !== redirectHtml) {
      throw new Error(`${file} must be an uninstrumented, noindex redirect to the homepage`);
    }
    redirects++;
    continue;
  }
  const occurrences = html.split(measurementId).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${file} contains ${occurrences} analytics IDs; expected exactly one`);
  }
}

if (redirects !== retiredCampaigns.size) {
  throw new Error(
    `Expected ${retiredCampaigns.size} retired campaign redirects, found ${redirects}`
  );
}

for (const marker of ['google-analytics-loader', 'google-analytics-config', 'send_page_view']) {
  const occurrences = javascript.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Built JavaScript contains ${occurrences} ${marker} markers; expected exactly one`
    );
  }
}

if (!javascript.includes('__agorGaLastLocation')) {
  throw new Error('Built JavaScript is missing the duplicate page-view guard');
}

console.log(
  `Validated one GA integration in each of ${htmlFiles.length - redirects} exported pages and ${redirects} uninstrumented redirects.`
);
