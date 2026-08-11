#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const snapshotPath = resolve(repositoryRoot, 'apps/agor-docs/public/openapi/agor.json');
const actualPath = process.argv[2];

if (!actualPath) {
  console.error('Usage: node scripts/check-openapi-snapshot.mjs <generated-docs.json>');
  process.exit(2);
}

function normalize(document) {
  const copy = structuredClone(document);
  // The daemon stamps its release version at build time. It does not change
  // the API surface represented by the checked-in reference.
  if (copy.info) copy.info.version = '<release-version>';
  return copy;
}

const [snapshot, actual] = await Promise.all(
  [snapshotPath, resolve(actualPath)].map(async (path) => JSON.parse(await readFile(path, 'utf8')))
);

if (JSON.stringify(normalize(snapshot)) !== JSON.stringify(normalize(actual))) {
  console.error(
    `OpenAPI snapshot is stale. Refresh it from a fully registered daemon:\n` +
      `  curl --fail --silent --show-error http://localhost:3030/docs.json | jq . > ${snapshotPath}\n`
  );
  process.exit(1);
}

console.log('OpenAPI snapshot matches the fully registered daemon schema.');
