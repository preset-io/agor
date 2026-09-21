#!/usr/bin/env node
/** Model-free, opt-in smoke against the disposable HA stack. Creates only JIT
 * fixture identities/boards; never starts agents or changes production tenants. */
import assert from 'node:assert/strict';

if (process.env.AGOR_HA_INTEGRATION !== '1') {
  console.log('SKIP: set AGOR_HA_INTEGRATION=1 against a disposable HA stack');
  process.exit(0);
}
const ingress = process.env.HA_URL ?? 'http://127.0.0.1:3030';
const replicas = [
  `http://127.0.0.1:${process.env.HA_DAEMON_A_PORT ?? '13031'}`,
  `http://127.0.0.1:${process.env.HA_DAEMON_B_PORT ?? '13032'}`,
];
const origins = [process.env.AGOR_HA_ACME_ORIGIN, process.env.AGOR_HA_GLOBEX_ORIGIN];
assert(origins.every(Boolean), 'Supply both expected fixture origins');
assert.notEqual(
  origins[0],
  origins[1],
  'Distinct origins are required to detect tenant routing leakage'
);
const fixtures = [
  ['acme', 'acme-alice'],
  ['globex', 'globex-beatrice'],
];

const identities = await Promise.all(
  fixtures.map(async ([tenant, persona], i) => {
    const selected = await fetch(`${ingress}/dev-auth/select`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-host': 'untrusted.example.test',
      },
      body: new URLSearchParams({ tenant, persona, return_to: '/ui/' }),
    });
    assert.equal(selected.status, 303);
    const target = new URL(selected.headers.get('location'));
    assert.equal(target.origin, origins[i]);
    const response = await fetch(`${replicas[i]}/auth/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ launchCode: target.searchParams.get('launch_code') }),
    });
    assert.equal(response.status, 201, `${tenant}: launch failed`);
    return { tenant, origin: origins[i], token: (await response.json()).accessToken };
  })
);

// Repeated, interleaved reads through both replicas catch process-global leakage.
const boardIds = [new Set(), new Set()];
for (let round = 0; round < 3; round++) {
  await Promise.all(
    identities.flatMap(({ tenant, origin, token }, i) =>
      replicas.map(async (base) => {
        const response = await fetch(`${base}/boards`, {
          headers: {
            authorization: `Bearer ${token}`,
            'x-forwarded-host': 'untrusted.example.test',
          },
        });
        assert.equal(response.status, 200, `${tenant}: board projection failed`);
        const result = await response.json();
        const boards = result.data ?? result;
        assert(boards.length > 0, `${tenant}: expected JIT-seeded board`);
        for (const board of boards) {
          assert.equal(new URL(board.url).origin, origin, `${tenant}: wrong board origin`);
          assert.match(new URL(board.url).pathname, /^\/ui\//);
          boardIds[i].add(board.board_id);
          // This verifies ingress serves the deep-link shell, not browser rendering.
          const shell = await fetch(board.url);
          assert.equal(shell.status, 200, `${tenant}: deep-link ingress failed`);
          assert.match(shell.headers.get('content-type'), /text\/html/);
        }
      })
    )
  );
}
for (const id of boardIds[0]) assert(!boardIds[1].has(id), 'Foreign board leaked across tenants');
for (const { tenant, origin } of identities) {
  for (const base of replicas) {
    const response = await fetch(`${base}/health`, { headers: { origin } });
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      origin,
      `${tenant}: CORS origin missing`
    );
  }
}
for (const base of replicas) {
  const response = await fetch(`${base}/health`, {
    headers: { origin: 'https://unconfigured.example.test' },
  });
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    null,
    'Unconfigured origin must not receive a CORS grant'
  );
}
console.log(
  'PASS: two signed tenant origins, both replicas, repeated isolated board projections, deep-link shells and exact CORS'
);
