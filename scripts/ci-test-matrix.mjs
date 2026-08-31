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
    // Daemon integration tests import executor source directly; a full
    // workspace install is required so that source file's @agor/core link is
    // present (pnpm's filtered install omits that undeclared test edge).
    filterArgs: [],
    // Daemon tests import executor source, which in turn resolves @agor/core's
    // published exports. Build that package explicitly in this filtered lane.
    buildFilter: '@agor/core',
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

const assignmentCounts = new Map();
for (const group of Object.values(groups)) {
  for (const packageName of group.packages) {
    assignmentCounts.set(packageName, (assignmentCounts.get(packageName) ?? 0) + 1);
  }
}
const listed = new Set(assignmentCounts.keys());
const missing = [...testBearingPackages.keys()].filter((name) => !listed.has(name));
const stale = [...listed].filter((name) => !testBearingPackages.has(name));
const duplicateAssignments = [...assignmentCounts.entries()]
  .filter(([name, count]) => count > 1 && name !== 'agor-ui')
  .map(([name, count]) => `${name} (${count} groups)`);
const uiAssignmentCount = assignmentCounts.get('agor-ui') ?? 0;
if (uiAssignmentCount !== 2)
  duplicateAssignments.push(`agor-ui (${uiAssignmentCount} groups; expected 2 shards)`);
if (missing.length || stale.length || duplicateAssignments.length) {
  if (missing.length)
    console.error(`Test-bearing workspaces missing from CI matrix: ${missing.join(', ')}`);
  if (stale.length)
    console.error(`CI matrix references workspaces without a test script: ${stale.join(', ')}`);
  if (duplicateAssignments.length)
    console.error(
      `Unexpected duplicate CI workspace assignments: ${duplicateAssignments.join(', ')}`
    );
  process.exit(1);
}

const workflowText = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const matrixMatch = workflowText.match(/^\s*group:\s*\[([^\]]+)\]/m);
if (!matrixMatch) throw new Error('CI workflow unit matrix is missing its group list');
const workflowGroups = matrixMatch[1]
  .split(',')
  .map((name) => name.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean);
const runnableGroups = Object.entries(groups)
  .filter(([, group]) => group.run)
  .map(([name]) => name);
const duplicateWorkflowGroups = workflowGroups.filter(
  (name, index) => workflowGroups.indexOf(name) !== index
);
const missingWorkflowGroups = runnableGroups.filter((name) => !workflowGroups.includes(name));
const staleWorkflowGroups = workflowGroups.filter((name) => !runnableGroups.includes(name));
if (duplicateWorkflowGroups.length || missingWorkflowGroups.length || staleWorkflowGroups.length) {
  if (duplicateWorkflowGroups.length)
    console.error(`Duplicate groups in ci.yml unit matrix: ${duplicateWorkflowGroups.join(', ')}`);
  if (missingWorkflowGroups.length)
    console.error(
      `Runnable groups missing from ci.yml unit matrix: ${missingWorkflowGroups.join(', ')}`
    );
  if (staleWorkflowGroups.length)
    console.error(
      `ci.yml unit matrix references unknown groups: ${staleWorkflowGroups.join(', ')}`
    );
  process.exit(1);
}
for (const [name, group] of Object.entries(groups)) {
  if (!group.run && group.lane !== 'build')
    throw new Error(`CI group ${name} must define runnable commands or a recognized owner lane`);
}
if (!workflowText.includes('pnpm --filter @agor/executor exec vitest run'))
  throw new Error('Build-owned executor Vitest checks are missing from ci.yml');
if (!workflowText.includes('pnpm --filter @agor/executor test:runtime'))
  throw new Error('Build-owned executor runtime checks are missing from ci.yml');

const browserTests = [];
async function collectBrowserTests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await collectBrowserTests(file);
    else if (entry.isFile() && entry.name.includes('.browser.test.'))
      browserTests.push(relative(repoRoot, file));
  }
}
for (const { directory } of testBearingPackages.values()) await collectBrowserTests(directory);
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
    const result = spawnSync('pnpm', args, { cwd: repoRoot, env: process.env, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}

throw new Error(`Unknown command: ${command}`);
