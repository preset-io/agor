#!/usr/bin/env node
/**
 * Model-free, opt-in smoke against the disposable HA stack: two tenants, two
 * origins, two replicas, `multi_tenancy.mode: required_from_auth`. Never
 * starts agents and never touches production tenants. It creates JIT fixture
 * identities and boards, plus (for the link assertions below) one throwaway
 * repo / branch / session per tenant, which it removes on the way out.
 *
 * WHAT THIS IS FOR. Under `required_from_auth`, `getBaseUrl` ignores
 * `AGOR_BASE_URL` entirely and resolves each tenant's own origin from durable
 * routing — which it can only do with a database handle or an ambient tenant
 * database scope. That branch is never taken by the SQLite single-tenant
 * suites, so a caller that passes neither is inert everywhere except here.
 * This harness is the fence: every user-facing link a hosted deployment hands
 * out must carry the caller's tenant origin, never the deployment cell's and
 * never another tenant's.
 *
 * It asserted that for BOARD urls only, which come from a repository that
 * holds `this.db` and therefore could not have the defect. It now also covers
 * the SESSION deep link — over REST, read back through the other replica, and
 * through the real `/mcp` endpoint, which is the boundary that enters tenant
 * CONTEXT only and is where the missing-handle defect actually lived — plus
 * the two landing paths a Slack MCP connect card and an `oauth` widget send a
 * user to.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, AND WHY. The two call sites fixed
 * alongside this — `agor_widgets_request_oauth`'s `session_url` and the Slack
 * connect card's button URL — are not reachable from an HTTP harness:
 *
 *   - `session_url` is returned only for a GATEWAY session, and
 *     `custom_context.gateway_source` is server-managed: every
 *     provider-carrying create is refused by `protectGatewaySourceMetadata`.
 *     The only way to make one is a real inbound platform message, which
 *     starts an agent.
 *   - The card's URL exists only inside a Block Kit post to a real Slack
 *     workspace. The delivery record it leaves behind is stripped from every
 *     API read (`stripWidgetSlackConnectDelivery`), and the URL is not in it.
 *
 * Both are fenced instead by hosted-mode unit coverage that drives the real
 * resolver against a real routing row:
 * `apps/agor-daemon/src/services/gateway-mcp-slack-connect.test.ts` and
 * `apps/agor-daemon/src/mcp/tools/widgets.oauth.test.ts`. What this harness
 * adds is the other half neither of those can have — two live tenants on two
 * live origins, resolved by a real daemon.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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

// Mirrors packages/core/src/types/mcp.ts and mcp/tokens.ts, like
// scripts/test-ha-mcp-branch-create.mjs. Needed because the MCP endpoint is the
// boundary the missing-handle defect lived on, so a link assertion that never
// goes through `/mcp` would not have caught it.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: HA test secret supplied by the Compose stack env, not a checked-in .env.
const jwtSecret = process.env.AGOR_JWT_SECRET;
assert(jwtSecret, 'AGOR_JWT_SECRET is required (must match the HA daemon JWT secret)');
const b64url = (input) =>
  Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');
function mintMcpToken({ sessionId, userId, tenantId }) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    sub: sessionId,
    uid: userId,
    tid: tenantId,
    aud: 'agor:mcp:internal',
    iss: 'agor',
    iat: now,
    exp: now + 3600,
    jti: crypto.randomUUID(),
  })}`;
  return `${data}.${crypto.createHmac('sha256', jwtSecret).update(data).digest('base64url')}`;
}

/** One `tools/call`, over whichever body shape the endpoint answers with. */
async function mcpToolCall(base, token, sessionHeader, name, args) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...sessionHeader,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200, `${name} HTTP status at ${base}: ${response.status}`);
  const text = await response.text();
  const messages = text.includes('data:')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .flatMap((line) => {
          try {
            return [JSON.parse(line.slice(5).trim())];
          } catch {
            return [];
          }
        })
    : [JSON.parse(text)];
  const result = messages.map((message) => message.result).find(Boolean);
  assert(result, `${name} returned no result at ${base}: ${text.slice(0, 300)}`);
  const content = (result.content ?? []).map((part) => part.text).join(' ');
  assert.equal(result.isError === true, false, `${name} failed at ${base}: ${content}`);
  return JSON.parse(content);
}

async function mcpInitialize(base, token) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'agor-ha-tenant-links', version: '1.0.0' },
      },
    }),
  });
  assert.equal(response.status, 200, `MCP initialize failed at ${base}: ${response.status}`);
  await response.text();
  const sid = response.headers.get('mcp-session-id');
  return sid ? { 'mcp-session-id': sid } : {};
}

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
    const launched = await response.json();
    return {
      tenant,
      origin: origins[i],
      token: launched.accessToken,
      userId: launched.user.user_id,
      replica: replicas[i],
    };
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

// ---------------------------------------------------------------------------
// Session deep links, reached from a service AND from the MCP endpoint.
//
// Boards alone were not enough of a fence. A board URL is built inside a
// repository that holds `this.db`, so the shape that broke — a caller with
// tenant context and no handle — cannot occur there. The MCP endpoint is
// exactly that shape: it arms tenant CONTEXT at the tool boundary, and
// anything a tool resolves from the ambient scope has to say so at the call
// site. Reading the same session back on the OTHER replica is what proves the
// origin came from durable tenant routing rather than from whichever process
// happened to answer.
// ---------------------------------------------------------------------------
const stamp = Date.now();
const created = [];
const sessionOrigins = [];
try {
  for (const [i, identity] of identities.entries()) {
    const { tenant, origin, token, userId, replica } = identity;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const other = replicas[(replicas.indexOf(replica) + 1) % replicas.length];
    const boardId = [...boardIds[i]][0];

    // A metadata-only remote row. The clone is a fire-and-forget executor step
    // and is not what this asserts.
    const repoResponse = await fetch(`${replica}/repos`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        slug: `ha-links-${tenant}-${stamp}`,
        name: `ha-links-${tenant}-${stamp}`,
        repo_type: 'remote',
        remote_url: 'https://github.com/octocat/Hello-World.git',
        default_branch: 'master',
        clone_status: 'ready',
        local_path: `/home/agor/.agor/repos/ha-links-${tenant}-${stamp}`,
      }),
    });
    assert.equal(repoResponse.status, 201, `${tenant}: repo registration failed`);
    const repoId = (await repoResponse.json()).repo_id;

    const branchResponse = await fetch(`${replica}/repos/${repoId}/branches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `ha-links-${stamp}`,
        boardId,
        createBranch: true,
        ref: `ha-links-${stamp}`,
        sourceBranch: 'master',
      }),
    });
    assert.equal(branchResponse.status, 201, `${tenant}: branch create failed`);
    const branch = await branchResponse.json();

    const sessionResponse = await fetch(`${replica}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        branch_id: branch.branch_id,
        title: `ha-tenant-links-${stamp}`,
        agentic_tool: 'claude-code',
      }),
    });
    assert.equal(sessionResponse.status, 201, `${tenant}: session create failed`);
    const session = await sessionResponse.json();
    created.push({ tenant, headers, replica, repoId, branchId: branch.branch_id, session });

    assert.equal(new URL(session.url).origin, origin, `${tenant}: wrong session origin on create`);
    assert.match(new URL(session.url).pathname, /^\/ui\//);
    sessionOrigins.push(new URL(session.url).origin);

    // The other replica answers the same tenant's link, on the same origin.
    const readBack = await fetch(`${other}/sessions/${session.session_id}`, { headers });
    assert.equal(readBack.status, 200, `${tenant}: cross-replica session read failed`);
    assert.equal(
      new URL((await readBack.json()).url).origin,
      origin,
      `${tenant}: cross-replica session link left the tenant origin`
    );

    // Through `/mcp`, on both replicas: tenant identity arrives on the token,
    // and the link still has to resolve to this tenant's routing.
    const mcpToken = mintMcpToken({ sessionId: session.session_id, userId, tenantId: tenant });
    for (const base of replicas) {
      const sessionHeader = await mcpInitialize(base, mcpToken);
      const viaMcp = await mcpToolCall(base, mcpToken, sessionHeader, 'agor_sessions_get', {
        sessionId: session.session_id,
      });
      assert.equal(
        new URL(viaMcp.url).origin,
        origin,
        `${tenant}: MCP session link left the tenant origin at ${base}`
      );
    }

    // The two landing paths a connect card and an `oauth` widget send a user
    // to, served by this tenant's ingress. `/connect/mcp` is where the Slack
    // card's button points; the session deep link is the fallback the agent
    // relays on every other platform and whenever the card is refused.
    for (const url of [session.url, `${origin}/ui/connect/mcp`]) {
      const shell = await fetch(url);
      assert.equal(shell.status, 200, `${tenant}: deep-link ingress failed for ${url}`);
      assert.match(shell.headers.get('content-type'), /text\/html/);
    }
  }

  assert.notEqual(
    sessionOrigins[0],
    sessionOrigins[1],
    'Both tenants resolved the same session origin, so routing is not per-tenant'
  );
} finally {
  // Best effort, in reverse creation order. A leftover fixture would be found
  // by the next run's slug collision rather than silently reused.
  for (const entry of created.reverse()) {
    for (const path of [
      `/sessions/${entry.session.session_id}`,
      `/branches/${entry.branchId}`,
      `/repos/${entry.repoId}`,
    ]) {
      await fetch(`${entry.replica}${path}`, { method: 'DELETE', headers: entry.headers }).catch(
        () => undefined
      );
    }
  }
}
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
  'PASS: two signed tenant origins, both replicas, repeated isolated board projections, ' +
    'per-tenant session links over REST and MCP, connect/session deep-link shells and exact CORS'
);
