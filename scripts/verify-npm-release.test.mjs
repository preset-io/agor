import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PACKAGES, verifyRelease } from './verify-npm-release.mjs';

const bytes = 'validated artifact';
const shasum = createHash('sha1').update(bytes).digest('hex');
function fixture(overrides = {}) {
  let time = 0;
  const calls = [];
  const logs = [];
  const options = {
    version: '1.2.3',
    tag: 'latest',
    packages: ['agor-live'],
    expectedHashes: new Map([['agor-live', shasum]]),
    timeoutMs: 100,
    intervalMs: 10,
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    log: (s) => logs.push(s),
    fetchImpl: async (url, init) => {
      const stage = url.endsWith('.tgz')
        ? 'tarball'
        : url.endsWith('dist-tags')
          ? 'tag'
          : 'metadata';
      calls.push({ stage, time, init });
      const response = overrides.respond?.(stage, time, init);
      if (response) return response;
      if (stage === 'tarball') return new Response(bytes);
      return Response.json(
        stage === 'tag'
          ? { latest: '1.2.3' }
          : {
              name: 'agor-live',
              version: '1.2.3',
              dist: {
                shasum,
                tarball: 'https://registry.npmjs.org/agor-live/-/agor-live-1.2.3.tgz',
              },
            }
      );
    },
  };
  return { options, calls, logs };
}

test('retries delayed metadata, tags and tarball; caches successful downloads', async () => {
  const f = fixture({
    respond: (stage, time) => {
      if (stage === 'metadata' && time < 20) return new Response('', { status: 404 });
      if (stage === 'tag' && time < 60) return Response.json({ latest: '1.2.2' });
      if (stage === 'tarball' && time < 40) return new Response('', { status: 503 });
    },
  });
  await verifyRelease(f.options);
  assert.equal(f.calls.filter((c) => c.stage === 'metadata').length, 3);
  assert.equal(f.calls.filter((c) => c.stage === 'tarball').length, 3);
  assert.match(f.logs.at(-1), /Verified 1 packages/);
  assert.ok(f.calls.every((c) => c.init.redirect === 'error' && c.init.signal));
});

test('one elapsed deadline for all eight packages, preserving network errors', async () => {
  const f = fixture({
    respond: () => {
      throw new Error('connection reset');
    },
  });
  await assert.rejects(
    verifyRelease({ ...f.options, packages: PACKAGES, expectedHashes: undefined }),
    (error) => {
      assert.match(error.message, /after 0.1s/);
      for (const name of PACKAGES) assert.ok(error.message.includes(name));
      assert.match(error.message, /metadata.*connection reset.*tag.*connection reset/);
      return true;
    }
  );
});

test('permanent tag mismatch exhausts deadline without re-downloading', async () => {
  const f = fixture({ respond: (stage) => stage === 'tag' && Response.json({ latest: '1.2.2' }) });
  await assert.rejects(verifyRelease(f.options), /tag.*latest=1.2.2; expected 1.2.3/);
  assert.equal(f.calls.filter((c) => c.stage === 'tarball').length, 1);
});

test('permanent metadata or tarball byte mismatch fails immediately', async () => {
  const f = fixture();
  await assert.rejects(
    verifyRelease({ ...f.options, expectedHashes: new Map([['agor-live', 'wrong']]) }),
    /differs from validated artifact/
  );
  const corrupted = fixture({
    respond: (stage) => stage === 'tarball' && new Response('wrong bytes'),
  });
  await assert.rejects(verifyRelease(corrupted.options), /downloaded tarball shasum mismatch/);
  assert.equal(corrupted.calls.filter((c) => c.stage === 'tarball').length, 1);
});

test('request timeout includes stalled response body, not only headers', async () => {
  const f = fixture({
    respond: (_stage, _time, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        })
      ),
  });
  await assert.rejects(
    verifyRelease({ ...f.options, requestTimeoutMs: 2, timeoutMs: 10 }),
    /request timed out/
  );
});

test('request timeout is clipped to remaining wall-clock budget', async () => {
  const f = fixture({
    respond: (_stage, _time, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  const start = performance.now();
  await assert.rejects(
    verifyRelease({
      ...f.options,
      now: () => performance.now(),
      timeoutMs: 20,
      requestTimeoutMs: 10_000,
    }),
    /timed out/
  );
  assert.ok(performance.now() - start < 1000);
});

test('rejects foreign tarball URL and invalid configuration before network use', async () => {
  const f = fixture({
    respond: (stage) =>
      stage === 'metadata' &&
      Response.json({
        name: 'agor-live',
        version: '1.2.3',
        dist: { shasum, tarball: 'https://example.com/a.tgz' },
      }),
  });
  await assert.rejects(verifyRelease(f.options), /not on the public registry/);
  await assert.rejects(verifyRelease({ ...f.options, timeoutMs: NaN }), /positive finite/);
  await assert.rejects(
    verifyRelease({ ...f.options, expectedHashes: new Map() }),
    /Missing validated artifact/
  );
});

test('workflow keeps verification success-gated after publishing with bounded headroom', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-agor-live.yml', import.meta.url),
    'utf8'
  );
  const verification = workflow.slice(workflow.indexOf('      - name: Verify registry release'));
  assert.match(verification, /timeout-minutes: 22/);
  assert.match(verification, /NPM_VERIFY_TIMEOUT_SECONDS.*600/);
  assert.match(verification, /"\$RUNNER_TEMP\/release"/);
  assert.doesNotMatch(verification, /always\(\)|continue-on-error|npm publish/);
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(workflow, /publish exact artifacts\n {8}timeout-minutes: 20/);
});

test('request work consumes the shared deadline and prereleases verify next', async () => {
  const f = fixture();
  let time = 0;
  let calls = 0;
  await assert.rejects(
    verifyRelease({
      ...f.options,
      now: () => time,
      fetchImpl: async () => {
        calls++;
        time += 60;
        throw new Error('slow request');
      },
    }),
    /after 0.1s/
  );
  assert.equal(calls, 2);
  const next = fixture({ respond: (stage) => stage === 'tag' && Response.json({ next: '1.2.3' }) });
  await verifyRelease({ ...next.options, tag: 'next' });
});
