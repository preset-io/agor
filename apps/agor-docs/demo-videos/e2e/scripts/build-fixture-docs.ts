// Render the fixture documents (fixtures/docs/*.html) to PDF with the
// suite's own Chromium, so the PDFs a clip attaches on camera are
// reproducible from committed source.
//
//   npx tsx scripts/build-fixture-docs.ts

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/docs');

const browser = await chromium.launch();
const page = await browser.newPage();
for (const file of readdirSync(DOCS).filter((f) => f.endsWith('.html'))) {
  await page.goto(`file://${path.join(DOCS, file)}`);
  const out = path.join(DOCS, file.replace(/\.html$/, '.pdf'));
  await page.pdf({ path: out, format: 'Letter', preferCSSPageSize: true });
  console.log(`wrote ${out}`);
}
await browser.close();
