import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewBase } from './image.mjs';

test('resolves the trusted public tag to an immutable digest with no controller credentials', async () => {
  const calls = [];
  const digest = `sha256:${'a'.repeat(64)}`;
  const result = await previewBase(async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    if (calls.length === 1) {
      assert.equal(new URL(url).hostname, 'auth.docker.io');
      assert.equal(options.headers, undefined);
      assert.equal(new URL(url).searchParams.get('scope').split(':').at(-1), 'pull');
      return Response.json({ token: 'public-token' });
    }
    assert.equal(new URL(url).hostname, 'registry-1.docker.io');
    assert.ok(url.endsWith('/manifests/preview-runtime-main'));
    assert.equal(options.headers.Authorization, 'Bearer public-token');
    return new Response(null, { headers: { 'docker-content-digest': digest } });
  });
  assert.ok(result.endsWith(`@${digest}`));
  assert.equal(calls.length, 2);
});

test('absent/private publication falls back; registry failures and invalid digests fail closed', async () => {
  for (const status of [404, 401, 429, 500, 200]) {
    let count = 0;
    const action = () =>
      previewBase(async () => {
        if (++count === 1) return Response.json({ token: 'public-token' });
        return new Response(null, { status, headers: { 'docker-content-digest': 'invalid' } });
      });
    if (status === 404 || status === 401) assert.equal(await action(), 'runtime-build');
    else await assert.rejects(action(), /Cannot resolve/);
  }
  await assert.rejects(
    previewBase(async () => {
      throw new Error('secret');
    }),
    /Cannot resolve/
  );
});
