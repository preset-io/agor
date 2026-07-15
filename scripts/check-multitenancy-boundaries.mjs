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
      'apps/agor-daemon/src/register-services.ts': 11,
      'apps/agor-daemon/src/register-routes.ts': 12,
      'apps/agor-daemon/src/startup.ts': 1,
      'apps/agor-daemon/src/services/artifacts.test.ts': 1,
      'apps/agor-daemon/src/services/artifacts.ts': 1,
      'apps/agor-daemon/src/services/boards.ts': 2,
      'apps/agor-daemon/src/services/repos.ts': 1,
      'apps/agor-daemon/src/services/claude-cli-integration.ts': 2,
      // The tenant-aware realtime facade: tenant/session channel join, the
      // publish handler, session-stream join, the existence-gated room lookup
      // (existingChannel — used by publish + leave paths so they never
      // materialize a room), and leave-all all live here on purpose.
      'apps/agor-daemon/src/utils/realtime-publish.ts': 7,
      'apps/agor-daemon/src/setup/socketio.ts': 18,
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
      'apps/agor-daemon/src/utils/tenant-db-scope.test.ts': 1,
      // The two tenant-aware deferral helpers deliberately leave the current
      // ALS store before scheduling and then re-enter identity or DB scope.
      'apps/agor-daemon/src/utils/tenant-db-scope.ts': 2,
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
      'packages/core/src/db/database-wrapper.ts': 1,
      'packages/core/src/db/tenant-scope.ts': 1,
      'packages/core/src/db/repositories/tasks.ts': 2,
      'packages/core/src/db/repositories/branches.ts': 1,
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
