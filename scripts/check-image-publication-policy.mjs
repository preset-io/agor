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
  'every explicit managed-environment start must build from or validate against its checked-out worktree'
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
    /io\.agor\.dev-image-input-fingerprint/,
    'the Codespaces bootstrap must verify the existing development image fingerprint'
  );
  assert.match(
    codespacesBootstrap,
    /compose_needs_build=true/,
    'the Codespaces bootstrap must build a missing or explicitly invalidated image'
  );
  assert.match(
    codespacesBootstrap,
    /docker compose -p agor-codespaces-sqlite up -d/,
    'the Codespaces bootstrap must reuse a valid existing development image'
  );
  assert.match(
    codespacesBootstrap,
    /docker compose -p agor-codespaces-sqlite rm -sfv agor-dev/,
    'Codespaces reconciliation must remove only obsolete anonymous dependency volumes'
  );
  assert.match(
    codespacesBootstrap,
    /docker inspect --format '\{\{\.Image\}\}'/,
    'Codespaces reconciliation must detect a service container left on an older image'
  );
  const developmentDockerfile = await readFile(path.join(root, 'docker/Dockerfile'), 'utf8');
  const developmentImageStages = developmentDockerfile.match(
    /^([\s\S]*?)^FROM base AS production/m
  )?.[1];
  assert.ok(
    developmentImageStages,
    'the development Dockerfile stage ancestry must remain discoverable'
  );
  assert.doesNotMatch(
    developmentImageStages,
    /^COPY .*\\$/m,
    'multiline development-image COPY needs matching fingerprint-policy parser support'
  );
  const fingerprintInputs = codespacesBootstrap
    .match(/development_image_input_files=\(\n([\s\S]*?)\n\)/)?.[1]
    ?.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(fingerprintInputs, 'the development image fingerprint input list must be readable');
  for (const requiredInput of [
    '.dockerignore',
    'docker/Dockerfile',
    'docker-compose.yml',
    'docker-compose.override.yml',
  ]) {
    assert.ok(
      fingerprintInputs.includes(requiredInput),
      `Codespaces fingerprint is missing required build input: ${requiredInput}`
    );
  }
  assert.match(
    codespacesBootstrap,
    /printf 'UID=%s\\nGID=%s\\n'/,
    'Codespaces fingerprint must include both development-image user build arguments'
  );
  const fingerprintCovers = (source) =>
    fingerprintInputs.some((pattern) => {
      const expression = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*');
      return new RegExp(`^${expression}$`).test(source);
    });
  const developmentCopySources = [...developmentImageStages.matchAll(/^COPY\s+(.+)$/gm)].flatMap(
    ([, operands]) => {
      if (/(?:^|\s)--from=/.test(operands)) return [];
      const paths = operands
        .trim()
        .split(/\s+/)
        .filter((item) => !item.startsWith('--'));
      return paths.slice(0, -1);
    }
  );
  for (const source of developmentCopySources) {
    assert.ok(
      fingerprintCovers(source),
      `development Dockerfile COPY source is missing from the Codespaces fingerprint: ${source}`
    );
  }
  assert.match(
    developmentDockerfile,
    /ARG AGOR_DEV_IMAGE_INPUT_FINGERPRINT=untracked/,
    'the development image must accept the bootstrap fingerprint as a build argument'
  );
  assert.match(
    developmentDockerfile,
    /LABEL io\.agor\.dev-image-input-fingerprint=/,
    'the development image must persist the fingerprint used for safe reuse'
  );
  const developmentCompose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(
    developmentCompose,
    /AGOR_DEV_IMAGE_INPUT_FINGERPRINT: \$\{AGOR_DEV_IMAGE_INPUT_FINGERPRINT:-untracked\}/,
    'Compose must forward the bootstrap fingerprint into the development image build'
  );
  const agorDevVolumes = developmentCompose.match(
    /^ {4}volumes:\n([\s\S]*?)^ {4}stdin_open:/m
  )?.[1];
  assert.ok(agorDevVolumes, 'the agor-dev volume contract must remain discoverable');
  assert.doesNotMatch(
    agorDevVolumes,
    /^ {6}-\s+type:/m,
    'long-form agor-dev volumes need matching anonymous-volume policy parser support'
  );
  const agorDevVolumeEntries = [...agorDevVolumes.matchAll(/^ {6}-\s+(.+)$/gm)].map((match) =>
    match[1].trim().replace(/^['"]|['"]$/g, '')
  );
  const anonymousVolumeTargets = agorDevVolumeEntries.filter((entry) => !entry.includes(':'));
  assert.ok(anonymousVolumeTargets.length > 0, 'the development dependency volumes must exist');
  for (const target of anonymousVolumeTargets) {
    assert.match(
      target,
      /^\/app(?:\/.+)?\/node_modules$/,
      `compose rm -v must never target anonymous persisted data: ${target}`
    );
  }
  assert.ok(
    agorDevVolumeEntries.includes('agor-home:/home/agor'),
    'the managed Agor home must remain a named volume that compose rm -v preserves'
  );
  assert.doesNotMatch(codespacesBootstrap, imageReference);
  assert.doesNotMatch(codespacesBootstrap, /docker (?:compose )?pull\b/);
}

console.log(
  'Image publication policy valid: PRs build+smoke locally, publish no image/cache, and checked-in consumers do not pull preset/agor.'
);
