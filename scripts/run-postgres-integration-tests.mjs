#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaces = ['packages/core', 'apps/agor-daemon'];
const defaultConcurrency = 3;
const maxConcurrency = 8;
const childTerminationGraceMs = 5_000;
const activeChildren = new Set();
const activeProcessTrees = new Set();
const activeDatabases = new Set();
let shutdownSignal = null;
let shutdownEscalation = Promise.resolve();

if (process.env.AGOR_DB_DIALECT !== 'postgresql') {
  console.error('AGOR_DB_DIALECT must be set to postgresql for the PostgreSQL integration lane.');
  process.exit(1);
}
if (!process.env.AGOR_TEST_POSTGRES_URL) {
  console.error('AGOR_TEST_POSTGRES_URL must point at the PostgreSQL application database.');
  process.exit(1);
}
if (!process.env.AGOR_TEST_POSTGRES_ADMIN_URL) {
  console.error(
    'AGOR_TEST_POSTGRES_ADMIN_URL is required to create isolated databases and install test extensions.'
  );
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

function resolveConcurrency() {
  const configured = process.env.AGOR_POSTGRES_TEST_CONCURRENCY?.trim();
  if (!configured) return defaultConcurrency;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxConcurrency) {
    throw new Error(
      `AGOR_POSTGRES_TEST_CONCURRENCY must be an integer from 1 to ${maxConcurrency}`
    );
  }
  return parsed;
}

function databaseUrl(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function resolveRunId() {
  const configured = process.env.AGOR_POSTGRES_TEST_RUN_ID?.trim();
  if (!configured) return `${Date.now().toString(36)}_${process.pid.toString(36)}`;
  if (!/^[a-z0-9_]{1,48}$/.test(configured)) {
    throw new Error(
      'AGOR_POSTGRES_TEST_RUN_ID must use 1-48 lowercase letters, numbers, or underscores'
    );
  }
  return configured;
}

async function signalProcessTree(processId, signal) {
  if (!processId) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(processId), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      let settled = false;
      killer.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      killer.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      killer.once('close', (code, taskkillSignal) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `taskkill exited with code ${code ?? 'null'} signal ${taskkillSignal ?? 'none'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`
            )
          );
        }
      });
    });
    return;
  }
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
}

async function signalProcessTreeAndReport(processId, signal) {
  try {
    await signalProcessTree(processId, signal);
  } catch (error) {
    console.error(`Could not ${signal} process tree ${processId}: ${error.message}`);
  }
}

function runVitest({ workspaceRoot, relativeTest, reportFile, appUrl, adminUrl }) {
  return new Promise((resolve) => {
    const vitestEntrypoint = path.join(workspaceRoot, 'node_modules', 'vitest', 'vitest.mjs');
    const child = spawn(
      process.execPath,
      [
        vitestEntrypoint,
        'run',
        '--no-file-parallelism',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportFile}`,
        relativeTest,
      ],
      {
        cwd: workspaceRoot,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          AGOR_DB_DIALECT: 'postgresql',
          AGOR_TEST_POSTGRES_URL: appUrl,
          AGOR_TEST_POSTGRES_ADMIN_URL: adminUrl,
        },
        stdio: 'inherit',
      }
    );
    activeChildren.add(child);
    if (child.pid) activeProcessTrees.add(child.pid);
    let forceKillTimeout;
    let timedOut = false;
    let settled = false;
    const finish = (exitCode, forgetProcessTree = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      activeChildren.delete(child);
      if (forgetProcessTree && child.pid) activeProcessTrees.delete(child.pid);
      resolve(exitCode);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`PostgreSQL test timed out after 300 seconds: ${relativeTest}`);
      void signalProcessTreeAndReport(child.pid, 'SIGTERM').then(() => {
        forceKillTimeout = setTimeout(() => {
          console.error(
            `PostgreSQL test did not stop after SIGTERM; sending SIGKILL: ${relativeTest}`
          );
          void signalProcessTreeAndReport(child.pid, 'SIGKILL').then(() => {
            if (child.pid) activeProcessTrees.delete(child.pid);
            finish(1);
          });
        }, childTerminationGraceMs);
      });
    }, 300_000);
    timeout.unref?.();
    child.once('error', (error) => {
      console.error(`Failed to run ${relativeTest}: ${error.message}`);
      finish(1);
    });
    child.once('exit', (code, signal) => {
      if (signal) console.error(`${relativeTest} terminated by ${signal}`);
      if (timedOut) return;
      finish(code ?? 1, shutdownSignal === null);
    });
  });
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

const discovered = workspaceTests
  .flatMap(({ workspace, workspaceRoot, postgresTests }) =>
    postgresTests.map((file) => ({
      workspace,
      workspaceRoot,
      file,
      relativeTest: path.relative(workspaceRoot, file),
    }))
  )
  .sort((a, b) => a.file.localeCompare(b.file));
if (discovered.length === 0) {
  console.error(
    'No *.postgres.test.ts files were discovered; refusing to report a false green run.'
  );
  process.exit(1);
}

const appBaseUrl = process.env.AGOR_TEST_POSTGRES_URL;
const adminBaseUrl = process.env.AGOR_TEST_POSTGRES_ADMIN_URL;
const appRole = decodeURIComponent(new URL(appBaseUrl).username);
if (!appRole) throw new Error('AGOR_TEST_POSTGRES_URL must include the application role');
const runId = resolveRunId();
const reportDirectory = mkdtempSync(path.join(tmpdir(), `agor-postgres-tests-${runId}-`));
const summary = { total: 0, passed: 0, failed: 0, skipped: 0, failedSuites: 0 };
const results = new Array(discovered.length);
const control = postgres(adminBaseUrl, { max: 1 });
let nextIndex = 0;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function dropDatabase(client, databaseName) {
  await client.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  activeDatabases.delete(databaseName);
}

function handleSignal(signal) {
  if (shutdownSignal) return;
  shutdownSignal = signal;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  console.error(`\nReceived ${signal}; stopping PostgreSQL tests and cleaning isolated databases.`);
  shutdownEscalation = (async () => {
    await Promise.all(
      [...activeProcessTrees].map((processId) => signalProcessTreeAndReport(processId, 'SIGTERM'))
    );
    await sleep(childTerminationGraceMs);
    await Promise.all(
      [...activeProcessTrees].map((processId) => signalProcessTreeAndReport(processId, 'SIGKILL'))
    );
    activeProcessTrees.clear();
  })();
}

process.once('SIGINT', () => void handleSignal('SIGINT'));
process.once('SIGTERM', () => void handleSignal('SIGTERM'));

async function verifyApplicationRole() {
  const app = postgres(appBaseUrl, { max: 1 });
  try {
    const [role] = await app`
      SELECT rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `;
    if (role?.rolsuper !== false || role.rolbypassrls !== false) {
      throw new Error(
        `Refusing PostgreSQL integration run: ${appRole} must be NOSUPERUSER and NOBYPASSRLS`
      );
    }
  } finally {
    await app.end();
  }
}

async function runIsolatedTest(entry, index) {
  const databaseName = `agor_test_${runId}_${index}`;
  const appUrl = databaseUrl(appBaseUrl, databaseName);
  const adminUrl = databaseUrl(adminBaseUrl, databaseName);
  const reportFile = path.join(reportDirectory, `${index}.json`);
  console.log(`\n[postgres:${entry.workspace}:${entry.relativeTest}] starting`);
  activeDatabases.add(databaseName);
  try {
    if (shutdownSignal) return;
    await control.unsafe(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(appRole)}`
    );
    if (shutdownSignal) return;
    const isolatedAdmin = postgres(adminUrl, { max: 1 });
    try {
      await isolatedAdmin.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    } finally {
      await isolatedAdmin.end();
    }
    if (shutdownSignal) return;
    const exitCode = await runVitest({
      workspaceRoot: entry.workspaceRoot,
      relativeTest: entry.relativeTest,
      reportFile,
      appUrl,
      adminUrl,
    });
    if (shutdownSignal) return;
    let reportFailed = false;
    try {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      summary.total += report.numTotalTests ?? 0;
      summary.passed += report.numPassedTests ?? 0;
      summary.failed += report.numFailedTests ?? 0;
      summary.skipped += report.numPendingTests ?? 0;
      summary.failedSuites += report.numFailedTestSuites ?? 0;
    } catch (error) {
      reportFailed = true;
      console.error(
        `Could not read the Vitest JSON report for ${entry.relativeTest}: ${error.message}`
      );
    }
    results[index] = exitCode === 0 && !reportFailed ? 0 : 1;
    console.log(
      `[postgres:${entry.workspace}:${entry.relativeTest}] ${results[index] === 0 ? 'passed' : 'failed'}`
    );
  } catch (error) {
    results[index] = 1;
    console.error(`[postgres:${entry.relativeTest}] ${error.message}`);
  } finally {
    try {
      await dropDatabase(control, databaseName);
    } catch (error) {
      results[index] = 1;
      console.error(`[postgres:${entry.relativeTest}] cleanup failed: ${error.message}`);
    }
  }
}

async function worker() {
  while (!shutdownSignal && nextIndex < discovered.length) {
    const index = nextIndex++;
    if (shutdownSignal) return;
    await runIsolatedTest(discovered[index], index);
  }
}

async function main() {
  try {
    await verifyApplicationRole();
    if (!shutdownSignal) {
      const concurrency = Math.min(resolveConcurrency(), discovered.length);
      console.log(
        `Running ${discovered.length} PostgreSQL test files in isolated databases with concurrency ${concurrency}`
      );
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }
    if (shutdownSignal) await shutdownEscalation;
  } finally {
    if (shutdownSignal) await shutdownEscalation;
    await Promise.all(
      [...activeProcessTrees].map((processId) => signalProcessTreeAndReport(processId, 'SIGKILL'))
    );
    activeProcessTrees.clear();
    for (const databaseName of [...activeDatabases]) {
      try {
        await dropDatabase(control, databaseName);
      } catch (error) {
        console.error(`Final cleanup failed for ${databaseName}: ${error.message}`);
      }
    }
    await control.end();
    rmSync(reportDirectory, { recursive: true, force: true });
  }

  if (shutdownSignal) return;
  console.log(
    `\nPostgreSQL integration summary: ${summary.passed} passed, ${summary.failed} failed, ` +
      `${summary.skipped} skipped (${summary.total} total across ${discovered.length} files).`
  );

  const failures = results.filter((code) => code !== 0).length;
  if (summary.total === 0 || summary.passed === 0) {
    console.error(
      'No PostgreSQL tests executed; the lane may have accidentally skipped every suite.'
    );
    process.exitCode = 1;
  }
  if (failures > 0 || summary.failed > 0 || summary.failedSuites > 0) process.exitCode = 1;
}

await main();
