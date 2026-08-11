import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const occurrences = html.split(measurementId).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${file} contains ${occurrences} analytics IDs; expected exactly one`);
  }
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

console.log(`Validated one GA integration in each of ${htmlFiles.length} exported pages.`);
