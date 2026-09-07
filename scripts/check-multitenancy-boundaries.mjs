#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function filesUnder(prefix) {
  return walk(join(ROOT, prefix)).map((file) => file.slice(ROOT.length + 1));
}

const checks = [
  {
    name: 'raw realtime/socket primitives',
    roots: ['apps/agor-daemon/src'],
    patterns: [
      /\bapp\.io\.(?:emit|to)\s*\(/g,
      /\bio\.(?:emit|to)\s*\(/g,
      /\bsocket\.broadcast(?:\.to)?\.emit\s*\(/g,
      /\bapp\.channel\s*\(/g,
      /\bapp\.publish\s*\(/g,
      /\.service\([^\n]+\)\.emit\s*\(/g,
      /\bsocket\.join\s*\(/g,
      /\bsocket\.leave\s*\(/g,
    ],
    // Baseline of existing call sites. New occurrences should go through the
    // tenant-aware realtime facade instead of adding more raw emits/rooms.
    baseline: {
      'apps/agor-daemon/src/register-hooks.ts': 1,
      // OAuth HA hints use the audited native-event inventory; authorization
      // URLs and standalone socket hints are explicitly local-only.
      'apps/agor-daemon/src/register-services.ts': 5,
      // HA fork/spawn now use the tenant-aware Feathers event helper instead
      // of raw global Socket.IO broadcasts.
      'apps/agor-daemon/src/register-routes.ts': 4,
      'apps/agor-daemon/src/startup.ts': 1,
      'apps/agor-daemon/src/services/artifacts.test.ts': 1,
      'apps/agor-daemon/src/services/artifacts.ts': 1,
      'apps/agor-daemon/src/services/boards.ts': 2,
      'apps/agor-daemon/src/services/repos.ts': 1,
      // Real REST + Socket.IO contract harness: the one authenticated test
      // connection is joined to a local-only channel so transport-level
      // response and realtime secret redaction can be asserted end to end.
      'apps/agor-daemon/src/services/mcp-servers.write-transport.integration.test.ts': 2,
      // Socket/browser integration harness explicitly joins one authenticated
      // connection to its verified tenant before asserting hard-delete
      // publication containment.
      'apps/agor-daemon/src/utils/branch-removal-realtime.integration.test.ts': 2,
      // The tenant-aware realtime facade: session/task channel joins, the
      // publish handler, and existence-gated lookups live here on purpose.
      // Executor control rooms are tenant-namespaced and joined only from an
      // immutable, verified scoped-JWT connection authority.
      'apps/agor-daemon/src/utils/realtime-publish.ts': 8,
      // Raw Socket.IO presence/user/terminal rooms are deliberately centralized
      // here. Every join/leave/broadcast is tenant-namespaced, including logout
      // cleanup, and cross-tenant negative tests cover same user/board IDs. The
      // terminal service additionally receives a server-only connection
      // capability that joins its authenticated requesting socket to a room
      // derived from trusted tenant/user/terminal identity before executor
      // startup. Same-room operations are serialized and re-check immutable
      // authority so retirement cannot leave stale membership; clients cannot
      // supply that room or capability. The navbar board-association protocol
      // adds one join and one leave at this same audited boundary; each room is
      // constructed from immutable tenant authority plus a boards.find-
      // authorized canonical board ID.
      'apps/agor-daemon/src/setup/socketio.ts': 13,
      // Adversarial integration harnesses intentionally exercise the raw
      // Socket.IO boundary: the PostgreSQL test probes a guessed foreign room
      // and inspects passive delivery, including authorized/private/forged
      // board-association heartbeats for member/admin/superadmin roles, while
      // the Redis test emits one cursor packet across two real adapter-backed
      // replicas. Production room names and authorization still come from the
      // centralized routing/config code.
      'apps/agor-daemon/src/setup/socketio-tenant-isolation.postgres.test.ts': 6,
      // The cursor packets are deliberately sent before and after revoke/
      // reconnect denial, and the board heartbeat independently verifies the
      // authorized association relay. These three test-only raw client emits
      // exercise the real Redis adapter boundary through shared event names.
      'apps/agor-daemon/src/setup/socketio-ha-tenant-isolation.integration.test.ts': 3,
      // Real immutable-handshake coverage deliberately inspects the private
      // Feathers task channel through one test helper and injects both executor
      // control event names into its current connections. Pre-disconnect
      // delivery and post-reconnect absence prove room retirement.
      'apps/agor-daemon/src/setup/socketio-executor-auth.integration.test.ts': 1,
    },
  },

  {
    name: 'raw CRUD service emits',
    roots: ['apps/agor-daemon/src'],
    excludeTests: true,
    patterns: [
      /\.service\([^\n]+\)(?:\.|\?\.)emit(?:\?\.)?\s*\(\s*['"](?:created|patched|updated|removed)['"]/g,
      /\bthis\.emit\?\.\(\s*['"](?:created|patched|updated|removed)['"]/gs,
    ],
    // Manual CRUD events must use emitServiceEvent() so realtime publishing
    // receives the service path, original params, and tenant-aware context.
    // Service-local CRUD emits predate emitServiceEvent(). Keep them explicit
    // so new call sites cannot silently expand this legacy surface.
    baseline: {},
  },

  {
    name: 'unscoped MCP database access',
    roots: ['apps/agor-daemon/src/mcp/tools'],
    excludeTests: true,
    patterns: [/\bctx\.db\b/g],
    // MCP handlers carry tenant identity only. Database work must go through
    // runWithMcpTenantDatabaseScope(), which opens a short RLS transaction and
    // supplies the guarded DB proxy to the callback.
    baseline: {},
  },

  {
    name: 'parameterless authentication service calls',
    roots: ['apps/agor-daemon/src'],
    excludeTests: true,
    patterns: [
      /\bauthService\.create\(\s*\{[^)]*\}\s*\)/gs,
      /\bapp\.service\(\s*['"]authentication['"]\s*\)\.create\(\s*\{[\s\S]*?\}\s*\);/g,
    ],
    // Custom HTTP middleware must pass a mutable params object so verified
    // tenant context is available to authentication hooks and user loading.
    baseline: {},
  },
  {
    name: 'raw tenant database scope imports',
    roots: ['apps/agor-daemon/src'],
    excludeTests: true,
    patterns: [/import\s*{[^}]*\btenantDatabaseScope\b[^}]*}\s*from\s*['"]@agor\/core\/db['"]/gs],
    baseline: {},
  },
  {
    name: 'raw tenant database scope exits',
    roots: ['packages/core/src', 'apps/agor-daemon/src'],
    patterns: [/\btenantDatabaseScope\.exit\s*\(/g],
    baseline: {
      'packages/core/src/db/tenant-context.ts': 1,
    },
  },
  {
    name: 'bare daemon setImmediate scheduling',
    roots: ['apps/agor-daemon/src'],
    patterns: [/\bsetImmediate\s*\(/g],
    baseline: {
      // Test-only async flush helpers / event loop flushes.
      'apps/agor-daemon/src/services/branches.test.ts': 1,
      'apps/agor-daemon/src/services/repos.test.ts': 1,
      // Executor-token revocation clears authority synchronously, then uses a
      // transport-only deferral helper to drain the terminal RPC ack before
      // teardown. Its callbacks perform no database or tenant-owned work.
      'apps/agor-daemon/src/setup/socketio.ts': 1,
      // Event-loop flushes for the exact-token disconnect assertions above.
      'apps/agor-daemon/src/setup/socketio.test.ts': 2,
      // The tenant-aware deferral helper deliberately leaves the current ALS
      // database store before scheduling and then re-enters tenant identity.
      'apps/agor-daemon/src/utils/tenant-db-scope.ts': 1,
    },
  },
  {
    name: 'raw daemon Database/RawDatabase imports',
    roots: ['apps/agor-daemon/src'],
    excludeTests: true,
    patterns: [
      /import\s+(?:type\s+)?{[^}]*(?:\bDatabase\b|\bRawDatabase\b)[^}]*}\s*from\s*['"]@agor\/core\/db(?:\/client)?['"]/gs,
      /import\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s*['"]@agor\/core\/db(?:\/client)?['"]/gs,
    ],
    baseline: {
      // Health probes take a Database handle to run a tenant-agnostic
      // connectivity check (SELECT 1) / migration count. This is explicit
      // global work: the probe enters an explicit system scope via
      // runWithSystemDatabaseScope (not a raw tenant-scope bypass), which is
      // the supported no-tenant path for guarded proxies.
      'apps/agor-daemon/src/health/db-probe.ts': 1,
      'apps/agor-daemon/src/health/routes.ts': 1,
      // Deployment-local maintenance accepts the raw runtime handle from the
      // CLI, uses system scope only for tenant-ID discovery, and re-enters
      // ordinary tenant scope before reading or deleting upload rows.
      'apps/agor-daemon/src/uploads-maintenance.ts': 1,
      // Widget renderer accepts both tenant-aware and repository-compatible database shapes.
      'apps/agor-daemon/src/widgets/env-vars/index.ts': 1,
    },
  },
  {
    name: 'raw Drizzle transactions',
    roots: ['packages/core/src', 'apps/agor-daemon/src'],
    patterns: [/\.transaction\s*\(/g],
    // Baseline of existing raw transaction call sites. New work should use the
    // Agor store/tenant transaction wrapper once introduced.
    baseline: {
      // Tenant scopes use one transaction for agor.tenant_id. Narrow system
      // capabilities use a second transaction path so their RLS GUC is local
      // to one pooled connection checkout and cannot leak after discovery.
      'packages/core/src/db/tenant-scope.ts': 2,
      // Test-only security harness deliberately invokes every direct libsql
      // and Drizzle transaction surface to prove the literal-memory client
      // coordinator cannot be bypassed. No application database access lives
      // in this file.
      'packages/core/src/db/in-memory-sqlite-coordinator.test.ts': 10,
      // 1 pre-existing, three provisioning compare-and-swaps, and the
      // provisioning-aware delete transaction.
      // (claimFailedForProvisioningRetry / markProvisioningFailedIfCreating /
      // acknowledgeProvisioningAttempt).
      // Those need a real transaction: the row lock and the state check must be
      // in the same unit of work, or two callers could both claim a retry and
      // dispatch two materializers. Callers enter runWithTenantDatabaseScope
      // first, so the transaction runs on the tenant-scoped handle.
      'packages/core/src/db/repositories/branches.ts': 5,
      'packages/core/src/db/repositories/knowledge.ts': 7,
      'packages/core/src/db/repositories/repos.ts': 3,
      // Session updates and archive cascades use raw repository transactions until
      // the Agor store/tenant transaction wrapper covers both patterns.
      'packages/core/src/db/repositories/sessions.ts': 2,
      'packages/core/src/db/repositories/schedules.ts': 1,
      'packages/core/src/seed/demo-fixtures.ts': 1,
    },
  },
];

function countMatches(text, patterns) {
  let total = 0;
  for (const pattern of patterns) total += [...text.matchAll(pattern)].length;
  return total;
}

let failed = false;
for (const check of checks) {
  const observed = new Map();
  for (const root of check.roots) {
    for (const file of filesUnder(root)) {
      if (check.excludeTests && file.endsWith('.test.ts')) continue;
      const count = countMatches(readFileSync(file, 'utf8'), check.patterns);
      if (count > 0) observed.set(file, count);
    }
  }

  for (const [file, count] of observed) {
    const allowed = check.baseline[file] ?? 0;
    if (count > allowed) {
      failed = true;
      console.error(
        `[multitenancy-boundaries] ${check.name}: ${file} has ${count} occurrence(s), baseline allows ${allowed}`
      );
    }
  }
  for (const [file, allowed] of Object.entries(check.baseline)) {
    const count = observed.get(file) ?? 0;
    if (count < allowed) {
      console.log(
        `[multitenancy-boundaries] ${check.name}: ${file} improved (${count}/${allowed}); please lower the baseline.`
      );
    }
  }
}

if (failed) {
  console.error(
    '\nUse tenant-aware store/realtime abstractions or explicitly update the baseline with a justification.'
  );
  process.exit(1);
}

console.log('[multitenancy-boundaries] ok');
