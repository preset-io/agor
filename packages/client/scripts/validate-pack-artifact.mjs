#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agor-client-pack-'));

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function listFilesRecursive(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

let tarballName;

try {
  const packOutput = execSync('npm pack --json', { cwd: packageDir, encoding: 'utf8' });
  const parsed = JSON.parse(packOutput);
  tarballName = parsed?.[0]?.filename;
  if (!tarballName) {
    throw new Error('npm pack did not return a filename');
  }
  execSync(`tar -xzf ${JSON.stringify(tarballName)} -C ${JSON.stringify(tempDir)}`, {
    cwd: packageDir,
  });
} catch (error) {
  fail(
    `Unable to create/extract npm pack artifact: ${error instanceof Error ? error.message : String(error)}`
  );
}

const packedRoot = path.join(tempDir, 'package');
const packedManifestPath = path.join(packedRoot, 'package.json');
const packedManifest = JSON.parse(readFileSync(packedManifestPath, 'utf8'));

const dependencySections = [
  ['dependencies', packedManifest.dependencies ?? {}],
  ['peerDependencies', packedManifest.peerDependencies ?? {}],
  ['optionalDependencies', packedManifest.optionalDependencies ?? {}],
];

for (const [sectionName, deps] of dependencySections) {
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      fail(`Packed manifest contains workspace protocol in ${sectionName}: ${name}=${version}`);
    }
  }
}

if (packedManifest.dependencies && Object.hasOwn(packedManifest.dependencies, '@agor/core')) {
  fail('Packed manifest must not contain @agor/core as a runtime dependency');
}

const packedFiles = listFilesRecursive(packedRoot);
const runtimeFiles = packedFiles.filter((file) => file.endsWith('.js') || file.endsWith('.cjs'));
const typeFiles = packedFiles.filter(
  (file) => file.endsWith('.d.ts') || file.endsWith('.d.cts') || file.endsWith('.d.mts')
);

for (const file of runtimeFiles) {
  const content = readFileSync(file, 'utf8');
  if (content.includes('@agor/core')) {
    fail(`Runtime artifact still references @agor/core: ${path.relative(packedRoot, file)}`);
  }
}

for (const file of typeFiles) {
  const content = readFileSync(file, 'utf8');
  if (content.includes('@agor/core')) {
    fail(`Type artifact still references @agor/core: ${path.relative(packedRoot, file)}`);
  }
}

try {
  if (tarballName) {
    unlinkSync(path.join(packageDir, tarballName));
  }
  rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Best-effort cleanup only.
}

if (!process.exitCode) {
  console.log('✅ npm pack artifact is standalone (no workspace deps or @agor/core references)');
}
