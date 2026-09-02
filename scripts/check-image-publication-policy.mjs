#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = '.github/workflows/build-image.yml';
const workflow = await readFile(path.join(root, workflowPath), 'utf8');

function step(name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

assert.match(workflow, /^name: Build image$/m);
assert.match(workflow, /^ {2}pull_request:$/m);
assert.match(workflow, /^ {4}name: Build & push$/m);

const validation = step('Validate image publication policy');
assert.match(validation, /run: node scripts\/check-image-publication-policy\.mjs/);

for (const name of ['Log in to Docker Hub', 'Docker metadata', 'Push image']) {
  assert.match(
    step(name),
    /if: github\.event_name != 'pull_request'/,
    `${name} must be disabled for every pull_request`
  );
}

const build = step('Build image');
assert.match(build, /target: production-source/);
assert.match(build, /load: true/);
assert.match(build, /tags: \$\{\{ env\.IMAGE \}\}:smoke/);
assert.match(build, /cache-from: type=gha,scope=agor-image/);
assert.match(
  build,
  /cache-to: \$\{\{ github\.event_name != 'pull_request' && 'type=gha,mode=max,scope=agor-image' \|\| '' \}\}/,
  'pull_request builds must not export an untrusted, branch-scoped GHA cache'
);

const smoke = step('Smoke test');
assert.match(smoke, /\$\{\{ env\.IMAGE \}\}:smoke/);
assert.match(smoke, /curl -fsS http:\/\/localhost:3030\/health/);

const push = step('Push image');
assert.match(push, /push: true/);
assert.match(push, /tags: \$\{\{ steps\.meta\.outputs\.tags \}\}/);
assert.doesNotMatch(step('Docker metadata'), /type=ref,event=pr/);

const promotion = step('Promote tested main image');
assert.match(promotion, /--tag "\$\{IMAGE\}:main"/);
assert.match(promotion, /--tag "\$\{IMAGE\}:latest"/);
assert.match(promotion, /"\$\{IMAGE\}:\$\{IMAGE_REVISION\}"/);

// A standalone preset/agor image may be produced by this workflow, but no
// checked-in runtime, environment, test, script, or deployment may consume it
// unnoticed. Component images such as preset/agor-daemon are intentionally
// distinct. The audit note is the sole non-runnable evidence file excluded.
const imageReference = new RegExp(
  String.raw`(?<![\w-])(?:docker\.io/)?${['preset', 'agor'].join('/')}(?=[:@\s"'\x60]|$)`
);
const runnableExtensions = new Set([
  '',
  '.bash',
  '.cjs',
  '.cts',
  '.env',
  '.fish',
  '.hcl',
  '.ini',
  '.js',
  '.json',
  '.jsonnet',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.nix',
  '.properties',
  '.ps1',
  '.sh',
  '.tf',
  '.toml',
  '.tpl',
  '.ts',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);
// `.context` is a gitignored Conductor scratch/evidence area and can contain
// complete historical checkouts. Policy scans repository source, not those
// local copies.
const excludedDirectories = new Set(['.context', '.git', 'node_modules']);
const excludedPaths = new Set([
  workflowPath,
  'docs/internal/pr-image-publication-audit-2026-08-28.md',
  'scripts/check-image-publication-policy.mjs',
]);
const references = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(absolute);
      continue;
    }
    if (!entry.isFile()) continue;

    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (excludedPaths.has(relative)) continue;
    const extension = path.extname(entry.name);
    const isSpecialName =
      entry.name === 'Dockerfile' ||
      entry.name.endsWith('.Dockerfile') ||
      entry.name === 'Makefile';
    if (!isSpecialName && !runnableExtensions.has(extension)) continue;

    let contents;
    try {
      contents = await readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    if (imageReference.test(contents)) references.push(relative);
  }
}

await scan(root);
assert.deepEqual(
  references,
  [],
  `standalone preset/agor image consumer(s) found outside ${workflowPath}: ${references.join(', ')}`
);

const managedEnvironments = await readFile(path.join(root, '.agor.yml'), 'utf8');
assert.doesNotMatch(managedEnvironments, imageReference);
assert.doesNotMatch(managedEnvironments, /docker (?:compose )?pull\b/);
const explicitStarts = [...managedEnvironments.matchAll(/^\s+start:\s*>-/gm)].length;
const localWorktreeBuildStarts = [
  ...managedEnvironments.matchAll(/\bup -d(?:\s+--build|[\s\S]{0,120}?\s+--build)\b/g),
].length;
const codespacesWorktreeBuildStarts = [
  ...managedEnvironments.matchAll(/agor-codespace-launcher\.mjs start\b/g),
].length;
assert.equal(
  explicitStarts,
  localWorktreeBuildStarts + codespacesWorktreeBuildStarts,
  'every explicit managed-environment start must build from its checked-out worktree'
);

if (codespacesWorktreeBuildStarts > 0) {
  assert.equal(
    codespacesWorktreeBuildStarts,
    1,
    'the reviewed remote-worktree build exception is limited to one Codespaces variant'
  );
  assert.match(
    managedEnvironments,
    /--devcontainer-path \.devcontainer\/agor-managed\/devcontainer\.json/,
    'the Codespaces variant must select the reviewed managed devcontainer'
  );
  assert.match(
    managedEnvironments,
    /agor-codespace-launcher\.mjs sync[\s\S]{0,320}?--revision \{\{shellQuote sync\.revision\}\}/,
    'the Codespaces variant must reconcile the exact, shell-quoted desired revision'
  );
  const codespacesDevcontainer = JSON.parse(
    await readFile(path.join(root, '.devcontainer/agor-managed/devcontainer.json'), 'utf8')
  );
  assert.deepEqual(
    codespacesDevcontainer.features?.['ghcr.io/devcontainers/features/sshd:1'],
    { version: 'latest' },
    'the managed devcontainer must install SSH for gh codespace health/log/sync commands'
  );
  const codespacesBootstrap = await readFile(
    path.join(root, '.devcontainer/agor-managed/start-agor-sqlite.sh'),
    'utf8'
  );
  assert.match(
    codespacesBootstrap,
    /docker compose -p agor-codespaces-sqlite up -d --build\b/,
    'the Codespaces bootstrap must build from the cloned remote worktree'
  );
  assert.doesNotMatch(codespacesBootstrap, imageReference);
  assert.doesNotMatch(codespacesBootstrap, /docker (?:compose )?pull\b/);
}

console.log(
  'Image publication policy valid: PRs build+smoke locally, publish no image/cache, and checked-in consumers do not pull preset/agor.'
);
