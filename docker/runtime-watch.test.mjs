import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { backendPort, createProxy, requiresRedeploy, syncIfChanged } from './runtime-watch.mjs';

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
  options.prepare = async () => {
    throw new Error('dependencies differ');
  };
  await assert.rejects(syncIfChanged(options), /dependencies/);
  assert.equal(syncs, 1);
  assert.equal(requiresRedeploy(['packages/core/src/db/migrations/sqlite/new.sql']), true);
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
