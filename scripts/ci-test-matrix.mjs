#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
/**
 * The PR CI test matrix is deliberately kept in code rather than inferred from
 * changed paths.  Every workspace that advertises a `test` script must appear
 * in one of these groups, so adding a test-bearing package cannot silently
 * remove coverage from the required check.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

export const groups = {
  core: {
    packages: ['@agor/core'],
    filterArgs: ['--filter=@agor/core...'],
    run: [['--filter', '@agor/core', 'exec', 'vitest', 'run']],
  },
  daemon: {
    packages: ['@agor/daemon'],
    filterArgs: ['--filter=@agor/daemon...'],
    buildFilter: '@agor/daemon...',
    run: [['--filter', '@agor/daemon', 'exec', 'vitest', 'run']],
  },
  'ui-1': {
    packages: ['agor-ui'],
    filterArgs: ['--filter=agor-ui...'],
    run: [['--filter', 'agor-ui', 'exec', 'vitest', 'run', '--shard=1/2']],
  },
  'ui-2': {
    packages: ['agor-ui'],
    filterArgs: ['--filter=agor-ui...'],
    run: [['--filter', 'agor-ui', 'exec', 'vitest', 'run', '--shard=2/2']],
  },
  executor: {
    packages: ['@agor/executor'],
    lane: 'build',
    // Both executor checks are intentionally run by the build lane after the
    // compiled artifact and all workspace declarations exist. Keeping this
    // metadata here lets the invariant checker count the package without
    // forcing a second dependency build in a filtered test runner.
  },
  cli: {
    packages: ['@agor/cli'],
    filterArgs: ['--filter=@agor/cli...'],
    buildFilter: '@agor/cli...',
    run: [['--filter', '@agor/cli', 'test']],
  },
  support: {
    packages: [
      '@agor/agentic-tool-opencode',
      '@agor/agentic-tools',
      '@agor-live/client',
      '@agor/git',
      'agor-live',
    ],
    filterArgs: [
      '--filter=@agor/agentic-tool-opencode...',
      '--filter=@agor/agentic-tools...',
      '--filter=@agor-live/client...',
      '--filter=@agor/git...',
      '--filter=agor-live',
    ],
    run: [
      ['--filter', '@agor/agentic-tool-opencode', 'test'],
      ['--filter', '@agor/agentic-tools', 'test'],
      ['--filter', '@agor-live/client', 'test'],
      ['--filter', '@agor/git', 'test'],
      ['--filter', 'agor-live', 'test'],
    ],
  },
};

const testBearingPackages = new Map();
for (const workspaceRoot of ['apps', 'packages']) {
  for (const entry of await readdir(join(repoRoot, workspaceRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = join(repoRoot, workspaceRoot, entry.name, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    } catch {
      continue;
    }
    if (typeof manifest.scripts?.test === 'string') {
      testBearingPackages.set(manifest.name, {
        directory: join(repoRoot, workspaceRoot, entry.name),
      });
    }
  }
}

const listed = new Set(Object.values(groups).flatMap((group) => group.packages));
const missing = [...testBearingPackages.keys()].filter((name) => !listed.has(name));
const stale = [...listed].filter((name) => !testBearingPackages.has(name));
if (missing.length || stale.length) {
  if (missing.length)
    console.error(`Test-bearing workspaces missing from CI matrix: ${missing.join(', ')}`);
  if (stale.length)
    console.error(`CI matrix references workspaces without a test script: ${stale.join(', ')}`);
  process.exit(1);
}

const browserTests = [];
for (const { directory } of testBearingPackages.values()) {
  const result = spawnSync(
    'find',
    [directory, '-type', 'f', '-name', '*.browser.test.*', '-print'],
    {
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) throw new Error(result.stderr);
  browserTests.push(
    ...result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((file) => relative(repoRoot, file))
  );
}
if (browserTests.some((file) => !file.startsWith('apps/agor-ui/'))) {
  throw new Error(
    `Browser tests must remain owned by the agor-ui browser lane: ${browserTests.join(', ')}`
  );
}

console.log(`CI test matrix covers ${listed.size} test-bearing workspaces.`);
for (const [name, group] of Object.entries(groups)) {
  console.log(`  ${name}: ${group.packages.join(', ')}`);
}
console.log(`Browser-only files (${browserTests.length}): ${browserTests.join(', ') || 'none'}`);

const [command, groupName] = process.argv.slice(2);
if (!command) process.exit(0);
if (!groups[groupName]) throw new Error(`Unknown CI test group: ${groupName}`);
const group = groups[groupName];

if (command === 'install') {
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile', ...group.filterArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  if (group.buildFilter) {
    const build = spawnSync('pnpm', ['turbo', 'run', 'build', `--filter=${group.buildFilter}`], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    process.exit(build.status ?? 1);
  }
  process.exit(0);
}

if (command === 'run') {
  if (!group.run) throw new Error(`CI test group ${groupName} is owned by the ${group.lane} lane`);
  for (const args of group.run) {
    // Keep the broad daemon suite's normal skip behavior. Only the focused
    // adapter command is service-gated; setting the URL for both would run the
    // same integration file twice and make Redis coverage harder to diagnose.
    const env =
      group.redis && args.includes('socketio-ha-tenant-isolation.integration.test.ts')
        ? { ...process.env, AGOR_TEST_REDIS_URL: 'redis://127.0.0.1:6379' }
        : process.env;
    const result = spawnSync('pnpm', args, { cwd: repoRoot, env, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}

throw new Error(`Unknown command: ${command}`);
