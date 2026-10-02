#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = '.github/workflows/build-image.yml';
const workflow = await readFile(path.join(root, workflowPath), 'utf8');

// Production copies the full source tree; managed development builds copy only
// dependency inputs. Keep every pnpm patch in that earlier install layer too.
const dockerfile = await readFile(path.join(root, 'docker/Dockerfile'), 'utf8');
const developmentInstallInputs = dockerfile
  .split('FROM base AS development')[1]
  ?.split('pnpm install --frozen-lockfile')[0];
assert.match(
  developmentInstallInputs ?? '',
  /^COPY patches\/ \.\/patches\/$/m,
  'development must copy the complete patches directory before the frozen install'
);

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

// pull_request workflows run from the merge ref: build that same tree, not
// an older PR head which may lack Docker targets added by the base workflow.
// workflow_run must still build the exact main commit that passed CI.
assert.match(
  workflow,
  /^ {2}IMAGE_REVISION: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}$/m,
  'image revision must match the PR merge workflow, or the tested main commit on workflow_run'
);
assert.match(step('Checkout'), /ref: \$\{\{ env\.IMAGE_REVISION \}\}/);

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
assert.match(build, /AGOR_BUILD_SHA=\$\{\{ env\.IMAGE_REVISION \}\}/);
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
const excludedDirectories = new Set(['.git', 'node_modules']);
const excludedPaths = new Set([
  workflowPath,
  'docs/internal/pr-image-publication-audit-2026-08-28.md',
  'scripts/check-image-publication-policy.mjs',
  'scripts/managed-environments/railway/image.mjs',
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
// Reviewed branch-local automatic Railway source build.
const railwaySourceBuildStarts = [
  ...managedEnvironments.matchAll(
    /node scripts\/managed-environments\/railway\/launcher\.mjs start\b/g
  ),
].length;
assert.equal(
  explicitStarts,
  localWorktreeBuildStarts + codespacesWorktreeBuildStarts + railwaySourceBuildStarts,
  'every explicit managed-environment start must build local source or use a reviewed remote-source exception'
);

if (railwaySourceBuildStarts > 0) {
  assert.equal(railwaySourceBuildStarts, 1, 'only one automatic Railway variant is reviewed');
  assert.match(
    managedEnvironments,
    /railway-sqlite:\s+start: >-\s+node scripts\/managed-environments\/railway\/launcher\.mjs start\s+--repository \{\{shellQuote repo.github_slug\}\} --ref \{\{shellQuote branch.ref\}\}\s+--binding \{\{shellQuote branch.id\}\}/
  );
  const directory = path.join(root, 'scripts/managed-environments/railway');
  const launcher = await readFile(path.join(directory, 'launcher.mjs'), 'utf8');
  const preview = await readFile(path.join(directory, 'preview.mjs'), 'utf8');
  const configuration = await readFile(path.join(directory, 'configuration.mjs'), 'utf8');
  assert.match(launcher, /api\.github\.com\/repos\/\$\{input.repository\}\/git\/ref\/heads\//);
  assert.match(launcher, /preview\.start\(owned, sha\)/);
  assert.match(preview, /serviceInstanceDeployV2\([^)]*commitSha:\$commitSha\)/);
  assert.match(preview, /source: \{ repo: this.input.repository \}/);
  assert.match(preview, /dockerfilePath: 'docker\/Dockerfile'/);
  assert.match(configuration, /AGOR_RUNTIME_TARGET: 'railway-preview'/);
  assert.match(configuration, /AGOR_PREVIEW_BASE: previewBase/);
  const checkout = await readFile(path.join(root, 'docker/runtime-checkout.mjs'), 'utf8');
  assert.match(
    checkout,
    /\.clone\(repo, staging, \['--depth=1', '--single-branch', '--branch', branch\]\)/
  );
  assert.match(checkout, /\.fetch\('origin', branch, \['--depth=1', '--no-tags'\]\)/);
  for (const source of [launcher, preview, configuration])
    assert.doesNotMatch(source, imageReference);
}

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
  const codespacesDevcontainer = JSON.parse(
    await readFile(path.join(root, '.devcontainer/agor-managed/devcontainer.json'), 'utf8')
  );
  assert.deepEqual(
    codespacesDevcontainer.features?.['ghcr.io/devcontainers/features/sshd:1'],
    { version: 'latest' },
    'the managed devcontainer must install SSH for gh codespace health/log commands'
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

// Narrow dependency-only exception: trusted main publication, never a PR image.
assert.match(step('Select Railway image validation'), /id: railway/);
assert.match(
  step('Select Railway image validation'),
  /shouldBuildRailwayImage\(\{ github, context \}\)/
);
assert.match(
  step('Select Railway image validation'),
  /core\.setOutput\('build', String\(build\)\)/
);
for (const name of [
  'Build preview runtime',
  'Smoke test preview runtime',
  'Test warm preview base',
]) {
  assert.match(step(name), /if: steps\.railway\.outputs\.build == 'true'/);
}
const previewBuild = step('Build preview runtime');
assert.match(previewBuild, /target: railway-preview/);
assert.match(previewBuild, /load: true/);
assert.match(previewBuild, /cache-to: \$\{\{ github.event_name == 'workflow_run'/);
assert.match(step('Push preview runtime'), /if: github.event_name == 'workflow_run'/);
assert.match(step('Push preview runtime'), /tags: .*:preview-runtime-\$\{\{ env.IMAGE_REVISION/);
assert.match(step('Smoke test preview runtime'), /runtime-checkout.mjs fingerprint/);
const warm = step('Test warm preview base');
assert.equal((warm.match(/--builder default --output=type=cacheonly/g) ?? []).length, 2);
assert.equal((warm.match(/--target railway-preview-checked/g) ?? []).length, 2);
assert.match(warm, /FROM railway-preview AS railway-preview-checked/);
assert.match(warm, /RUN test .*runtime-checkout\.mjs fingerprint.*agor-dependency-fingerprint/);
assert.match(warm, /&& cd \/app\/packages\/git/);
assert.match(warm, /&& node -e 'require\("simple-git"\)'/);
assert.match(warm, /--build-arg AGOR_PREVIEW_BASE=/);
assert.match(warm, /Installing changed preview dependencies/);
assert.match(warm, /Reusing preview dependencies/);
assert.match(warm, /trap .*package.json/);
assert.doesNotMatch(warm, /--push|--load|docker run/);
assert.match(promotion, /--tag "\$\{IMAGE\}:preview-runtime-main"/);
assert.match(promotion, /"\$\{IMAGE\}:preview-runtime-\$\{IMAGE_REVISION\}"/);
const resolver = await readFile(
  path.join(root, 'scripts/managed-environments/railway/image.mjs'),
  'utf8'
);
assert.match(resolver, /manifests\/preview-runtime-main/);
assert.match(resolver, /return `preset\/agor@\$\{digest\}`/);
assert.doesNotMatch(resolver, /process.env/);
assert.match(dockerfile, /ARG AGOR_PREVIEW_BASE=runtime-build/);
assert.match(dockerfile, /FROM \$\{AGOR_PREVIEW_BASE\} AS railway-preview/);
const previewStage = dockerfile
  .split('AS railway-preview')[1]
  .split(/FROM \$\{AGOR_RUNTIME_TARGET\}/)[0];
assert.match(previewStage, /pnpm install --frozen-lockfile/);
assert.match(previewStage, /agor-dependency-fingerprint/);
assert.doesNotMatch(previewStage, /COPY \. \./);

// Keep the thin wrapper's dependency inputs in parity with its cold base.
for (const line of dockerfile.split('AS railway-preview')[0].split('\n')) {
  if (
    line.startsWith('COPY ') &&
    (line.includes('package.json') || line.startsWith('COPY patches/'))
  ) {
    assert.ok(
      previewStage.includes(
        line.replace(/^COPY (?:--chown=agor:agor )?/, 'COPY --chown=agor:agor ')
      ),
      `preview stage missing dependency input: ${line}`
    );
  }
}
console.log(
  'Image publication policy valid: PRs publish no image/cache; only the reviewed Railway dependency-base consumer is allowed.'
);
