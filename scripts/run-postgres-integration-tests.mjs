#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaces = ['packages/core', 'apps/agor-daemon'];

if (process.env.AGOR_DB_DIALECT !== 'postgresql') {
  console.error('AGOR_DB_DIALECT must be set to postgresql for the PostgreSQL integration lane.');
  process.exit(1);
}
if (!process.env.AGOR_TEST_POSTGRES_URL) {
  console.error('AGOR_TEST_POSTGRES_URL must point at the disposable PostgreSQL test database.');
  process.exit(1);
}

function findTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...findTests(entryPath));
    else if (entry.name.endsWith('.test.ts')) tests.push(entryPath);
  }
  return tests;
}

const workspaceTests = workspaces.map((workspace) => {
  const workspaceRoot = path.join(repoRoot, workspace);
  const tests = findTests(path.join(workspaceRoot, 'src'));
  const postgresTests = tests.filter((file) => file.endsWith('.postgres.test.ts'));
  const misnamedGatedTests = tests.filter(
    (file) =>
      !file.endsWith('.postgres.test.ts') &&
      readFileSync(file, 'utf8').includes('AGOR_TEST_POSTGRES_URL')
  );
  return { workspace, workspaceRoot, postgresTests, misnamedGatedTests };
});

const misnamedGatedTests = workspaceTests.flatMap(({ misnamedGatedTests: files }) => files);
if (misnamedGatedTests.length > 0) {
  console.error(
    'PostgreSQL-gated suites must use the *.postgres.test.ts suffix so CI selects them:'
  );
  for (const file of misnamedGatedTests) console.error(`- ${path.relative(repoRoot, file)}`);
  process.exit(1);
}

const discoveredCount = workspaceTests.reduce(
  (count, group) => count + group.postgresTests.length,
  0
);
if (discoveredCount === 0) {
  console.error(
    'No *.postgres.test.ts files were discovered; refusing to report a false green run.'
  );
  process.exit(1);
}

const reportDirectory = mkdtempSync(path.join(tmpdir(), 'agor-postgres-tests-'));
const summary = { total: 0, passed: 0, failed: 0, skipped: 0, failedSuites: 0 };
let testCommandFailed = false;

try {
  for (const { workspace, workspaceRoot, postgresTests } of workspaceTests) {
    if (postgresTests.length === 0) continue;

    const reportFile = path.join(reportDirectory, `${path.basename(workspace)}.json`);
    const relativeTests = postgresTests
      .map((file) => path.relative(workspaceRoot, file))
      .sort((a, b) => a.localeCompare(b));

    console.log(`\nRunning ${relativeTests.length} PostgreSQL test file(s) in ${workspace}...`);
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--no-file-parallelism',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportFile}`,
        ...relativeTests,
      ],
      {
        cwd: workspaceRoot,
        env: process.env,
        stdio: 'inherit',
        timeout: 180_000,
      }
    );

    if (result.error) {
      console.error(`Failed to run PostgreSQL tests in ${workspace}: ${result.error.message}`);
      testCommandFailed = true;
    }
    if (result.status !== 0) testCommandFailed = true;

    try {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      summary.total += report.numTotalTests ?? 0;
      summary.passed += report.numPassedTests ?? 0;
      summary.failed += report.numFailedTests ?? 0;
      summary.skipped += report.numPendingTests ?? 0;
      summary.failedSuites += report.numFailedTestSuites ?? 0;
    } catch (error) {
      console.error(`Could not read the Vitest JSON report for ${workspace}: ${error.message}`);
      testCommandFailed = true;
    }
  }
} finally {
  rmSync(reportDirectory, { recursive: true, force: true });
}

console.log(
  `\nPostgreSQL integration summary: ${summary.passed} passed, ${summary.failed} failed, ` +
    `${summary.skipped} skipped (${summary.total} total across ${discoveredCount} files).`
);

if (summary.total === 0 || summary.passed === 0) {
  console.error(
    'No PostgreSQL tests executed; the lane may have accidentally skipped every suite.'
  );
  process.exit(1);
}
if (testCommandFailed || summary.failed > 0 || summary.failedSuites > 0) process.exit(1);
