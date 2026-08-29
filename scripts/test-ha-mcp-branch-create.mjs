#!/usr/bin/env node

/**
 * HA regression for the multi-tenant MCP branch-create failure.
 *
 * Before the fix, `agor_branches_create` (and other ReposService/BoardsService
 * custom-method MCP calls) threw "Missing tenant database scope for daemon
 * database access" under `required_from_auth`, because the MCP tool boundary
 * enters only tenant *context* while those custom methods touch the guarded
 * daemon DB directly. See docs/internal/mcp-tenant-db-scope-createbranch-2026-08-29.md.
 *
 * This exercises the real `/mcp` endpoint on both HA replicas, with a minted
 * session MCP token, and asserts:
 *   - REST /repos/:id/branches control path succeeds (baseline).
 *   - MCP agor_branches_create succeeds on daemon A and daemon B (replica routing).
 *   - waitForReady=false AND waitForReady=true both succeed.
 *   - Concurrent MCP creates all succeed (no tenant-scope bleed across requests).
 *   - agor_cards_get (CardsService.getWithType, same failure class) runs under scope.
 *   - agor_sessions_archive (SessionsService.setArchiveStateForTree) runs under scope.
 *   - A tenant-B MCP token cannot create against a tenant-A repo (RLS isolation).
 *
 * Gated like scripts/test-daemon-ha.mjs — requires a running Compose stack.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

if (process.env.AGOR_HA_INTEGRATION !== '1') {
  console.log('SKIP: set AGOR_HA_INTEGRATION=1 to exercise the HA MCP branch-create path');
  process.exit(0);
}

// biome-ignore lint/suspicious/noUndeclaredEnvVars: HA test secret supplied by the Compose stack env, not a checked-in .env.
const JWT_SECRET = process.env.AGOR_JWT_SECRET;
assert(JWT_SECRET, 'AGOR_JWT_SECRET is required (must match the HA daemon JWT secret)');

const ingress = process.env.HA_URL ?? `http://127.0.0.1:${process.env.HA_PORT ?? '3030'}`;
const daemonA = `http://127.0.0.1:${process.env.HA_DAEMON_A_PORT ?? '13031'}`;
const daemonB = `http://127.0.0.1:${process.env.HA_DAEMON_B_PORT ?? '13032'}`;

// Mirrors packages/core/src/types/mcp.ts MCP_TOKEN_AUDIENCE / MCP_TOKEN_ISSUER
// and the HS256 claim shape minted by mcp/tokens.ts generateSessionToken.
const MCP_TOKEN_AUDIENCE = 'agor:mcp:internal';
const MCP_TOKEN_ISSUER = 'agor';

const b64url = (input) =>
  Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');

function mintMcpToken({ sessionId, userId, tenantId }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: sessionId,
    uid: userId,
    tid: tenantId,
    aud: MCP_TOKEN_AUDIENCE,
    iss: MCP_TOKEN_ISSUER,
    iat: now,
    exp: now + 3600,
    jti: crypto.randomUUID(),
  };
  const data = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

async function loginPersona({ tenant, persona }, base = daemonA) {
  const selected = await fetch(`${ingress}/dev-auth/select`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tenant, persona, return_to: '/ui/' }),
  });
  assert.equal(selected.status, 303, `persona selection failed: ${selected.status}`);
  const launchCode = new URL(selected.headers.get('location')).searchParams.get('launch_code');
  assert(launchCode, 'persona selection did not return a launch code');
  const response = await fetch(`${base}/auth/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ launchCode }),
  });
  assert.equal(response.status, 201, `persona launch failed: ${response.status}`);
  return response.json();
}

function parseMcpBody(text) {
  // The endpoint may answer with a single JSON body or an SSE stream.
  if (text.includes('data:')) {
    return text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

async function mcpCall(base, token, body, extraHeaders = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    sid: res.headers.get('mcp-session-id'),
    messages: parseMcpBody(await res.text()),
  };
}

async function mcpInitialize(base, token) {
  const init = await mcpCall(base, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agor-ha-mcp-branch-create', version: '1.0.0' },
    },
  });
  assert.equal(init.status, 200, `MCP initialize failed at ${base}: ${init.status}`);
  if (init.sid) {
    await mcpCall(
      base,
      token,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        'mcp-session-id': init.sid,
      }
    );
  }
  return init.sid;
}

/** Call agor_branches_create and return the tool result payload (parsed). */
async function mcpCreateBranch(base, token, sid, args) {
  const res = await mcpCall(
    base,
    token,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'agor_branches_create', arguments: args },
    },
    sid ? { 'mcp-session-id': sid } : {}
  );
  assert.equal(res.status, 200, `tools/call HTTP status at ${base}: ${res.status}`);
  const result = res.messages.map((m) => m.result).find(Boolean);
  assert(
    result,
    `tools/call returned no result at ${base}: ${JSON.stringify(res.messages).slice(0, 300)}`
  );
  const text = (result.content ?? []).map((c) => c.text).join(' ');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  return { isError: result.isError === true, text, payload };
}

async function registerRepo(base, headers, slug) {
  // A remote row is enough for branch metadata creation; the clone itself is a
  // fire-and-forget executor step and is not what this test exercises.
  const res = await fetch(`${base}/repos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      slug,
      name: slug,
      repo_type: 'remote',
      remote_url: 'https://github.com/octocat/Hello-World.git',
      default_branch: 'master',
      clone_status: 'ready',
      local_path: `/home/agor/.agor/repos/${slug}`,
    }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, `repo registration failed: ${res.status} ${body}`);
  return JSON.parse(body).repo_id;
}

async function firstBoardId(base, headers) {
  const res = await fetch(`${base}/boards`, { headers });
  assert.equal(res.status, 200, `board list failed: ${res.status}`);
  const body = await res.json();
  const boards = body.data ?? body;
  assert(boards.length > 0, 'tenant has no board to place branches on');
  return boards[0].board_id;
}

async function createSession(base, headers, branchId) {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      branch_id: branchId,
      title: 'ha-mcp-regression',
      agentic_tool: 'claude-code',
    }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, `session create failed: ${res.status} ${body}`);
  return JSON.parse(body).session_id;
}

async function createCardType(base, headers, name) {
  const res = await fetch(`${base}/card-types`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, `card-type create failed: ${res.status} ${body}`);
  return JSON.parse(body).card_type_id;
}

/** Call an arbitrary MCP tool and return { isError, text, payload }. */
async function mcpToolCall(base, token, sid, name, args) {
  const res = await mcpCall(
    base,
    token,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
    sid ? { 'mcp-session-id': sid } : {}
  );
  assert.equal(res.status, 200, `${name} HTTP status at ${base}: ${res.status}`);
  const result = res.messages.map((m) => m.result).find(Boolean);
  assert(
    result,
    `${name} returned no result at ${base}: ${JSON.stringify(res.messages).slice(0, 300)}`
  );
  const text = (result.content ?? []).map((c) => c.text).join(' ');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  return { isError: result.isError === true, text, payload };
}

const stamp = Date.now();

// ---- Tenant A: full REST + MCP round-trip ----------------------------------
const alice = await loginPersona({ tenant: 'acme', persona: 'acme-alice' });
const aHeaders = {
  authorization: `Bearer ${alice.accessToken}`,
  'content-type': 'application/json',
};
const aUserId = alice.user.user_id;
const aBoardId = await firstBoardId(daemonA, aHeaders);
const aRepoId = await registerRepo(daemonA, aHeaders, `ha-mcp-${stamp}`);

// REST control: this path enters the tenant DB scope via the route around hook.
const restRes = await fetch(`${daemonA}/repos/${aRepoId}/branches`, {
  method: 'POST',
  headers: aHeaders,
  body: JSON.stringify({
    name: `rest-control-${stamp}`,
    boardId: aBoardId,
    createBranch: true,
    ref: `rest-control-${stamp}`,
    sourceBranch: 'master',
  }),
});
assert.equal(restRes.status, 201, `REST control branch create failed: ${restRes.status}`);
const controlBranch = await restRes.json();
console.log('ok - REST /repos/:id/branches control path creates a branch under tenant scope');

const aSessionId = await createSession(daemonA, aHeaders, controlBranch.branch_id);
const aToken = mintMcpToken({ sessionId: aSessionId, userId: aUserId, tenantId: 'acme' });

// MCP create on BOTH replicas, BOTH wait modes.
for (const [label, base] of [
  ['daemon-a', daemonA],
  ['daemon-b', daemonB],
]) {
  const sid = await mcpInitialize(base, aToken);
  for (const waitForReady of [false, true]) {
    const args = {
      repoId: aRepoId,
      branchName: `mcp-${label}-${waitForReady ? 'wait' : 'nowait'}-${stamp}`,
      boardId: aBoardId,
      waitForReady,
      ...(waitForReady ? { waitTimeoutMs: 8000 } : {}),
    };
    const result = await mcpCreateBranch(base, aToken, sid, args);
    // Primary regression guard: the scope error must be gone in both modes.
    assert(
      !/Missing tenant database scope/i.test(result.text),
      `tenant scope regression on ${label} (waitForReady=${waitForReady}): ${result.text}`
    );
    assert.equal(
      result.isError,
      false,
      `MCP agor_branches_create failed on ${label} (waitForReady=${waitForReady}): ${result.text}`
    );
    assert(
      typeof result.payload?.branch_id === 'string',
      `MCP agor_branches_create returned no branch on ${label} (waitForReady=${waitForReady}): ${result.text}`
    );
    if (waitForReady) {
      // The wait path executed and produced a *bounded* readiness outcome
      // (ready OR timeout — both are non-error) rather than the scope failure.
      // Materialization of a synthetic repo may legitimately time out, so we do
      // not assert `ready` specifically; we assert the wait code path ran.
      // Assert the machine-readable outcome rather than user-facing message text.
      const outcome = result.payload?._readiness?.outcome;
      assert(
        outcome === 'ready' || outcome === 'timeout',
        `waitForReady did not render a bounded readiness outcome on ${label} (outcome=${outcome}): ${result.text}`
      );
    }
  }
  console.log(
    `ok - MCP agor_branches_create runs with no scope regression on ${label} (waitForReady false and true)`
  );
}

// Concurrent creates share the pooled Postgres connections; each must open and
// clean up its own tenant scope without bleeding into a sibling request.
const sidConcurrent = await mcpInitialize(daemonA, aToken);
const concurrent = await Promise.all(
  Array.from({ length: 5 }, (_unused, i) =>
    mcpCreateBranch(daemonA, aToken, sidConcurrent, {
      repoId: aRepoId,
      branchName: `mcp-concurrent-${i}-${stamp}`,
      boardId: aBoardId,
      waitForReady: false,
    })
  )
);
for (const [i, result] of concurrent.entries()) {
  assert.equal(result.isError, false, `concurrent create ${i} failed: ${result.text}`);
}
console.log('ok - concurrent MCP branch creates all succeed with no tenant-scope bleed');

// agor_cards_get exercises CardsService.getWithType — a custom, non-transport
// method that reads the card repository over `this.db` directly, the same
// failure class as branch create. It must also run under an active tenant scope.
const aCardTypeId = await createCardType(daemonA, aHeaders, `ha-type-${stamp}`);
// Cards must be created via createWithPlacement (already wrapped) — use the MCP
// tool so this stays a pure MCP-path check.
const cardCreate = await mcpToolCall(daemonA, aToken, sidConcurrent, 'agor_cards_create', {
  boardId: aBoardId,
  cardTypeId: aCardTypeId,
  title: `ha-card-${stamp}`,
});
assert.equal(cardCreate.isError, false, `agor_cards_create failed: ${cardCreate.text}`);
const aCardId = cardCreate.payload?.card?.card_id;
assert(typeof aCardId === 'string', `agor_cards_create returned no card id: ${cardCreate.text}`);

const cardGet = await mcpToolCall(daemonA, aToken, sidConcurrent, 'agor_cards_get', {
  cardId: aCardId,
});
assert(
  !/Missing tenant database scope/i.test(cardGet.text),
  `tenant scope regression in agor_cards_get: ${cardGet.text}`
);
assert.equal(cardGet.isError, false, `agor_cards_get failed: ${cardGet.text}`);
console.log('ok - MCP agor_cards_get runs under tenant scope (no regression)');

// agor_sessions_archive exercises SessionsService.setArchiveStateForTree — raw
// this.db reads/writes with no internal scope, the same failure class. Archive a
// throwaway target session.
const targetSessionId = await createSession(daemonA, aHeaders, controlBranch.branch_id);
const archiveRes = await mcpToolCall(daemonA, aToken, sidConcurrent, 'agor_sessions_archive', {
  sessionId: targetSessionId,
  includeChildren: false,
});
assert(
  !/Missing tenant database scope/i.test(archiveRes.text),
  `tenant scope regression in agor_sessions_archive: ${archiveRes.text}`
);
assert.equal(archiveRes.isError, false, `agor_sessions_archive failed: ${archiveRes.text}`);
console.log('ok - MCP agor_sessions_archive runs under tenant scope (no regression)');

// ---- Tenant B: cross-tenant negative ---------------------------------------
const beatrice = await loginPersona({ tenant: 'globex', persona: 'globex-beatrice' }, daemonB);
const bHeaders = {
  authorization: `Bearer ${beatrice.accessToken}`,
  'content-type': 'application/json',
};
const bUserId = beatrice.user.user_id;
const bBoardId = await firstBoardId(daemonB, bHeaders);
const bRepoId = await registerRepo(daemonB, bHeaders, `ha-mcp-b-${stamp}`);
const bBranchRes = await fetch(`${daemonB}/repos/${bRepoId}/branches`, {
  method: 'POST',
  headers: bHeaders,
  body: JSON.stringify({
    name: `b-control-${stamp}`,
    boardId: bBoardId,
    createBranch: true,
    ref: `b-control-${stamp}`,
    sourceBranch: 'master',
  }),
});
assert.equal(bBranchRes.status, 201, `tenant B control branch failed: ${bBranchRes.status}`);
const bSessionId = await createSession(daemonB, bHeaders, (await bBranchRes.json()).branch_id);
const bToken = mintMcpToken({ sessionId: bSessionId, userId: bUserId, tenantId: 'globex' });

const sidB = await mcpInitialize(daemonB, bToken);
const crossTenant = await mcpCreateBranch(daemonB, bToken, sidB, {
  // tenant-A repo id, tenant-B credentials — RLS must hide it.
  repoId: aRepoId,
  branchName: `cross-tenant-${stamp}`,
  boardId: bBoardId,
  waitForReady: false,
});
assert.equal(
  crossTenant.isError,
  true,
  'tenant B unexpectedly created a branch against a tenant A repo'
);
assert(
  !/Missing tenant database scope/i.test(crossTenant.text),
  `cross-tenant denial must be a tenant-isolation error, not a scope bug: ${crossTenant.text}`
);
console.log(
  'ok - tenant B MCP token cannot create a branch against a tenant A repo (RLS isolation)'
);

console.log('PASS: HA MCP branch-create tenant scope regression');
