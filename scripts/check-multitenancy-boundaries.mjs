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
      'apps/agor-daemon/src/register-hooks.ts': 11,
      'apps/agor-daemon/src/register-services.ts': 12,
      'apps/agor-daemon/src/register-routes.ts': 19,
      'apps/agor-daemon/src/startup.ts': 1,
      'apps/agor-daemon/src/services/artifacts.test.ts': 1,
      'apps/agor-daemon/src/services/artifacts.ts': 9,
      'apps/agor-daemon/src/services/branches.ts': 3,
      'apps/agor-daemon/src/services/boards.ts': 2,
      'apps/agor-daemon/src/services/repos.ts': 1,
      'apps/agor-daemon/src/services/claude-cli-integration.ts': 3,
      'apps/agor-daemon/src/mcp/tools/artifacts.ts': 1,
      'apps/agor-daemon/src/mcp/tools/boards.ts': 2,
      'apps/agor-daemon/src/mcp/tools/cards.ts': 8,
      'apps/agor-daemon/src/utils/realtime-publish.ts': 4,
      'apps/agor-daemon/src/setup/socketio.ts': 18,
    },
  },

  {
    name: 'raw tenant database scope imports',
    roots: ['apps/agor-daemon/src'],
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
    baseline: {},
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
      'packages/core/src/db/repositories/sessions.ts': 1,
      'packages/core/src/db/repositories/schedules.ts': 1,
      'packages/core/src/seed/demo-fixtures.ts': 1,
      'apps/agor-daemon/src/services/scheduler.ts': 1,
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
