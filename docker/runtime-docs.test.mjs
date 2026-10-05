import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  docsEnvironment,
  docsFingerprint,
  docsRequiresRedeploy,
  docsSyncArgs,
} from './runtime-docs.mjs';
import { syncIfChanged } from './runtime-watch.mjs';

test('real source sync updates and deletes pages without touching dependencies/compiler cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-docs-sync-'));
  try {
    const source = join(root, 'source');
    const docs = join(source, 'apps/agor-docs');
    const target = join(root, 'target');
    await mkdir(docs, { recursive: true });
    await mkdir(target);
    for (const path of ['node_modules', '.next', 'out', 'public/_pagefind']) {
      await mkdir(join(target, path), { recursive: true });
      await writeFile(join(target, path, 'sentinel'), 'retained');
    }
    await writeFile(join(docs, 'page.mdx'), 'before');
    await writeFile(join(docs, '.env.local'), 'never-copy');
    await writeFile(join(target, 'deleted.mdx'), 'obsolete');
    const sync = () => promisify(execFile)('rsync', docsSyncArgs(source, `${target}/`));
    await sync();
    assert.equal(await readFile(join(target, 'page.mdx'), 'utf8'), 'before');
    await assert.rejects(readFile(join(target, '.env.local')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(target, 'deleted.mdx')), { code: 'ENOENT' });
    await writeFile(join(docs, 'page.mdx'), 'after update');
    await sync();
    assert.equal(await readFile(join(target, 'page.mdx'), 'utf8'), 'after update');
    for (const path of ['node_modules', '.next', 'out', 'public/_pagefind'])
      assert.equal(await readFile(join(target, path, 'sentinel'), 'utf8'), 'retained');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('docs passes only public preview configuration, not controller or app credentials', () => {
  const env = docsEnvironment({
    PATH: '/bin',
    PORT: '3030',
    AGOR_DOCS_PREVIEW_ORIGIN: 'https://example.up.railway.app',
    RAILWAY_API_TOKEN: 'secret',
    RAILWAY_AGOR_ADMIN_PASSWORD: 'secret',
    NEXT_PUBLIC_GA_ID: 'do-not-forward',
    NODE_OPTIONS: '--require=untrusted',
  });
  assert.equal(env.NEXT_PUBLIC_SITE_URL, 'https://example.up.railway.app');
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(JSON.stringify(env).includes('secret'), false);
  assert.equal(env.NEXT_PUBLIC_GA_ID, undefined);
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=2048');
  for (const origin of [
    'http://example.com',
    'https://example.com/path',
    'https://user:pass@example.com',
  ])
    assert.throws(() => docsEnvironment({ AGOR_DOCS_PREVIEW_ORIGIN: origin }));
});

test('docs fingerprint uses frozen workspace inputs without requiring daemon packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-docs-fingerprint-'));
  try {
    for (const dir of ['patches', 'apps/agor-docs', 'packages/git'])
      await mkdir(join(root, dir), { recursive: true });
    for (const file of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'apps/agor-docs/package.json',
      'packages/git/package.json',
      'patches/fix.patch',
    ])
      await writeFile(join(root, file), '{}');
    const initial = await docsFingerprint(root);
    await writeFile(join(root, 'apps/agor-docs/content.mdx'), 'new source');
    assert.equal(await docsFingerprint(root), initial);
    for (const file of [
      'apps/agor-docs/package.json',
      'packages/git/package.json',
      'pnpm-lock.yaml',
      'patches/fix.patch',
    ]) {
      await writeFile(join(root, file), 'changed dependency');
      assert.notEqual(await docsFingerprint(root), initial);
      await writeFile(join(root, file), '{}');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('watch applies source updates once but defers incompatible dependency/startup changes', async () => {
  let syncs = 0;
  const opts = {
    appliedSha: 'old',
    prepare: async () => ({ sha: 'new', checkout: '/owned' }),
    changedPaths: async () => ['apps/agor-docs/content/guide/index.mdx'],
    needsRedeploy: docsRequiresRedeploy,
    sync: async () => {
      syncs++;
    },
  };
  const next = await syncIfChanged(opts);
  assert.equal(next, 'new');
  assert.equal(await syncIfChanged({ ...opts, appliedSha: next }), 'new');
  assert.equal(syncs, 1);
  for (const path of [
    'docker/runtime-docs.mjs',
    'apps/agor-docs/next.config.mjs',
    'apps/agor-docs/scripts/serve-and-open.mjs',
  ]) {
    await assert.rejects(syncIfChanged({ ...opts, changedPaths: async () => [path] }), /redeploy/);
  }
  await assert.rejects(
    syncIfChanged({
      ...opts,
      prepare: async () => {
        throw new Error('dependencies differ');
      },
    }),
    /dependencies/
  );
  assert.equal(syncs, 1);
});

test('sync preserves compiler/dependencies and copies only docs, excluding local env files', async () => {
  const args = docsSyncArgs('/owned');
  assert.deepEqual(args.slice(-2), ['/owned/apps/agor-docs/', '/app/apps/agor-docs/']);
  for (const name of ['node_modules', '.next*', 'out', '.git', '.env*', 'public/_pagefind'])
    assert.ok(args.includes(`--exclude=${name}`));
  const dockerfile = await readFile(new URL('./Dockerfile.docs-preview', import.meta.url), 'utf8');
  assert.match(dockerfile, /--filter @agor\/docs --filter @agor\/git install --frozen-lockfile/);
  assert.match(dockerfile, /CMD \["--watch"\]/);
  const entry = await readFile(new URL('./docker-entrypoint-docs.sh', import.meta.url), 'utf8');
  assert.match(entry, /exec gosu agor/);
  assert.match(entry, /flock -n 9/);
});
