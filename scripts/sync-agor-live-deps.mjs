#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const targetManifest = 'packages/agor-live/package.json';
const sourceManifests = [
  'packages/core/package.json',
  'apps/agor-cli/package.json',
  'apps/agor-daemon/package.json',
];

const skipDeps = new Set(['@agor/core']);
const mode = process.argv.includes('--check') ? 'check' : 'write';

const readJson = (relPath) => JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
const writeJson = (relPath, data) =>
  writeFileSync(resolve(repoRoot, relPath), `${JSON.stringify(data, null, 2)}\n`);

const target = readJson(targetManifest);
const targetDeps = { ...(target.dependencies ?? {}) };

const aggregated = new Map();
const conflicts = [];

for (const manifest of sourceManifests) {
  const pkg = readJson(manifest);
  for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
    if (skipDeps.has(dep)) continue;
    const seen = aggregated.get(dep);
    if (seen && seen !== version) {
      conflicts.push({ dep, seen, version, manifest });
    } else if (!seen) {
      aggregated.set(dep, version);
    }
  }
}

if (conflicts.length) {
  console.error('Dependency version conflicts detected while gathering workspace manifests:');
  for (const conflict of conflicts) {
    console.error(
      ` - ${conflict.dep}: saw ${conflict.seen}, ${conflict.manifest} declares ${conflict.version}`
    );
  }
  process.exit(1);
}

const updates = [];
for (const [dep, version] of aggregated) {
  const current = targetDeps[dep];
  if (current !== version) {
    updates.push({ dep, from: current, to: version });
    if (mode === 'write') {
      targetDeps[dep] = version;
    }
  }
}

if (mode === 'check') {
  if (updates.length) {
    console.error('packages/agor-live/package.json is missing dependency updates:');
    for (const update of updates) {
      console.error(` - ${update.dep}: expected ${update.to}, found ${update.from ?? '∅'}`);
    }
    console.error('Run pnpm sync:agor-live-deps to fix.');
    process.exit(1);
  }
  console.log('agor-live dependencies are in sync.');
  process.exit(0);
}

if (!updates.length) {
  console.log('agor-live dependencies already match workspace manifests.');
  process.exit(0);
}

const sortedDeps = {};
for (const dep of Object.keys(targetDeps).sort()) {
  sortedDeps[dep] = targetDeps[dep];
}

target.dependencies = sortedDeps;
writeJson(targetManifest, target);

console.log(`Updated ${targetManifest} with ${updates.length} change(s):`);
for (const update of updates) {
  console.log(` - ${update.dep}: ${update.from ?? '∅'} -> ${update.to}`);
}
