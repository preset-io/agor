import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  backendPort,
  createProxy,
  requiresRedeploy,
  runtimeGit,
  syncIfChanged,
} from './runtime-watch.mjs';

test('public path routing keeps app/HMR separate from authenticated API/socket routes', () => {
  for (const path of ['/ui/', '/ui/@vite/client', '/ui/?token=synthetic'])
    assert.equal(backendPort(path), 5173);
  for (const path of [
    '/health',
    '/authentication',
    '/users',
    '/socket.io/?transport=websocket',
    '/ui-fake',
  ])
    assert.equal(backendPort(path), 3031);
});

test('poll skips unchanged commits, applies once, rejects startup/schema/dependency changes', async () => {
  let syncs = 0;
  const options = {
    appliedSha: 'old',
    prepare: async () => ({ sha: 'old', checkout: '/owned' }),
    changedPaths: async () => ['apps/agor-ui/src/index.tsx'],
    sync: async () => {
      syncs++;
    },
  };
  assert.equal(await syncIfChanged(options), 'old');
  assert.equal(syncs, 0);
  options.prepare = async () => ({ sha: 'new', checkout: '/owned' });
  assert.equal(await syncIfChanged(options), 'new');
  assert.equal(syncs, 1);
  options.changedPaths = async () => ['docker/Dockerfile'];
  await assert.rejects(syncIfChanged(options), /redeploy/);
  assert.equal(syncs, 1);
  for (const migration of [
    'packages/core/drizzle/sqlite/0001_example.sql',
    'packages/core/drizzle/postgres/0001_example.sql',
    'packages/core/drizzle/sqlite/meta/_journal.json',
    'packages/core/drizzle/postgres/meta/_journal.json',
  ]) {
    assert.equal(requiresRedeploy([migration]), true);
    options.changedPaths = async () => ['apps/agor-ui/src/index.tsx', migration];
    await assert.rejects(syncIfChanged(options), /redeploy/);
    assert.equal(syncs, 1, 'mixed application and migration updates must not partially sync');
  }
  options.prepare = async () => {
    throw new Error('dependencies differ');
  };
  await assert.rejects(syncIfChanged(options), /dependencies/);
  assert.equal(syncs, 1);
});

test('proxy rejects cross-origin WebSocket upgrades before reaching a backend', async () => {
  const proxy = createProxy('https://preview.example');
  await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.server.address().port,
        path: '/ui/',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'https://foreign.example' },
      });
      req.on('upgrade', () => reject(new Error('Unexpected accepted upgrade')));
      req.on('error', resolve);
      req.end();
    });
  } finally {
    proxy.close();
  }
});

test('readiness preserves the daemon configuration contract consumed by the UI', async () => {
  const payload = { status: 'ok', identity: { mode: 'local' }, config: { login: true } };
  for (const uiReady of [true, false]) {
    const proxy = createProxy('https://preview.example', {
      healthRequest: async (url) => ({
        ok: url.endsWith('/health') || uiReady,
        json: async () => payload,
      }),
    });
    await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    try {
      const r = await fetch(`http://127.0.0.1:${proxy.server.address().port}/health`);
      assert.equal(r.status, uiReady ? 200 : 503);
      const body = await r.json();
      assert.deepEqual(body.identity, payload.identity);
      assert.deepEqual(body.config, payload.config);
      assert.equal(body.status, uiReady ? 'ok' : 'starting');
    } finally {
      proxy.close();
    }
  }
});

test('runtime git configures the real simple-git timeout option and strips inherited credentials', async () => {
  const require = createRequire(new URL('../packages/git/package.json', import.meta.url));
  const { simpleGit } = require('simple-git');
  const git = runtimeGit(simpleGit, { PATH: process.env.PATH, HOME: process.env.HOME });
  assert.match((await git(process.cwd()).revparse(['HEAD'])).trim(), /^[0-9a-f]{40}$/);
});
