#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const targetManifest = 'packages/agor-live/package.json';
const sourceManifests = [
  'packages/agentic-tool-opencode/package.json',
  'packages/agentic-tools/package.json',
  'packages/core/package.json',
  'packages/git/package.json',
  'apps/agor-cli/package.json',
  'apps/agor-daemon/package.json',
  'packages/executor/package.json',
];

// Internal workspace packages are materialized inside the agor-live tarball.
// Keep workspace references in the source manifest so pnpm links local projects;
// the release packer rewrites them to the materialized packages' exact versions.
const skipDeps = new Set([
  '@agor/agentic-tool-opencode',
  '@agor/agentic-tools',
  '@agor/core',
  '@agor/daemon',
  '@agor/git',
]);
const bundledInternalPackages = new Set([
  '@agor/agentic-tool-opencode',
  '@agor/agentic-tools',
  '@agor/core',
  '@agor/git',
]);
const mode = process.argv.includes('--check') ? 'check' : 'write';

const readJson = (relPath) => JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
const writeJson = (relPath, data) =>
  writeFileSync(resolve(repoRoot, relPath), `${JSON.stringify(data, null, 2)}\n`);

const target = readJson(targetManifest);
const targetDeps = { ...(target.dependencies ?? {}) };
const targetOptionalDeps = { ...(target.optionalDependencies ?? {}) };
// This is the only dependency owned directly by the publishable wrapper.
// Everything else is derived from the copied workspace packages below.
const targetOnlyDependencies = new Set(['@agor-live/client']);

const aggregated = new Map();
const aggregatedOptional = new Map();
const conflicts = [];

for (const manifest of sourceManifests) {
  const pkg = readJson(manifest);
  if (bundledInternalPackages.has(pkg.name)) aggregated.set(pkg.name, 'workspace:*');
}

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
  for (const [dep, version] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (skipDeps.has(dep) || aggregated.has(dep)) continue;
    const seen = aggregatedOptional.get(dep);
    if (seen && seen !== version) {
      conflicts.push({ dep, seen, version, manifest });
    } else if (!seen) {
      aggregatedOptional.set(dep, version);
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
for (const dep of Object.keys(targetDeps)) {
  if (!targetOnlyDependencies.has(dep) && !aggregated.has(dep)) {
    updates.push({ dep, from: targetDeps[dep], to: undefined });
    if (mode === 'write') delete targetDeps[dep];
  }
}
for (const [dep, version] of aggregated) {
  const current = targetDeps[dep];
  if (current !== version) {
    updates.push({ dep, from: current, to: version });
    if (mode === 'write') {
      targetDeps[dep] = version;
    }
  }
}
for (const dep of Object.keys(targetOptionalDeps)) {
  if (!aggregatedOptional.has(dep)) {
    updates.push({ dep: `optional:${dep}`, from: targetOptionalDeps[dep], to: undefined });
    if (mode === 'write') delete targetOptionalDeps[dep];
  }
}
for (const [dep, version] of aggregatedOptional) {
  const current = targetOptionalDeps[dep];
  if (current !== version) {
    updates.push({ dep: `optional:${dep}`, from: current, to: version });
    if (mode === 'write') targetOptionalDeps[dep] = version;
  }
}

if (mode === 'check') {
  if (updates.length) {
    console.error('packages/agor-live/package.json is missing dependency updates:');
    for (const update of updates) {
      console.error(` - ${update.dep}: expected ${update.to ?? '∅'}, found ${update.from ?? '∅'}`);
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
target.optionalDependencies = Object.fromEntries(
  Object.entries(targetOptionalDeps).sort(([left], [right]) => left.localeCompare(right))
);
writeJson(targetManifest, target);

console.log(`Updated ${targetManifest} with ${updates.length} change(s):`);
for (const update of updates) {
  console.log(` - ${update.dep}: ${update.from ?? '∅'} -> ${update.to ?? '∅'}`);
}
