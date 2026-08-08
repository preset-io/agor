#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminUrl = process.env.AGOR_TEST_POSTGRES_ADMIN_URL;
if (process.platform !== 'linux') {
  console.log('PostgreSQL runner interruption harness is Linux-only; skipping process inspection.');
  process.exit(0);
}
if (
  process.env.AGOR_DB_DIALECT !== 'postgresql' ||
  !process.env.AGOR_TEST_POSTGRES_URL ||
  !adminUrl
) {
  console.error(
    'The interruption harness requires AGOR_DB_DIALECT, AGOR_TEST_POSTGRES_URL, and AGOR_TEST_POSTGRES_ADMIN_URL.'
  );
  process.exit(1);
}

const runId = `interrupt_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const marker = `agor-postgres-interruption-${runId}`;
const reportPrefix = `agor-postgres-tests-${runId}-`;
let output = '';
let signaled = false;
let triggerSignal;
const started = new Promise((resolve) => {
  triggerSignal = resolve;
});

const child = spawn(process.execPath, ['scripts/run-postgres-integration-tests.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AGOR_POSTGRES_INTERRUPTION_PROBE: marker,
    AGOR_POSTGRES_TEST_CONCURRENCY: '1',
    AGOR_POSTGRES_TEST_RUN_ID: runId,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function capture(chunk) {
  output += chunk.toString();
  if (!signaled && output.includes('RUN  v')) {
    signaled = true;
    triggerSignal();
  }
}

child.stdout.on('data', capture);
child.stderr.on('data', capture);
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
const startTimeout = setTimeout(() => triggerSignal(), 60_000);
await started;
clearTimeout(startTimeout);
if (!signaled) {
  child.kill('SIGKILL');
  throw new Error(`Runner did not start Vitest before the interruption deadline.\n${output}`);
}
child.kill('SIGTERM');
const exitTimeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
const exit = await exited;
clearTimeout(exitTimeout);

function markedProcessIds() {
  const needle = Buffer.from(`AGOR_POSTGRES_INTERRUPTION_PROBE=${marker}\0`);
  const matches = [];
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      if (readFileSync(`/proc/${entry.name}/environ`).includes(needle)) matches.push(entry.name);
    } catch {
      // Processes can exit between directory enumeration and reading environ.
    }
  }
  return matches;
}

await new Promise((resolve) => setTimeout(resolve, 250));
const admin = postgres(adminUrl, { max: 1 });
let databases;
try {
  databases = await admin`
    SELECT datname
    FROM pg_database
    WHERE datname LIKE ${`agor_test_${runId}_%`}
  `;
} finally {
  await admin.end();
}
const reports = readdirSync(tmpdir()).filter((entry) => entry.startsWith(reportPrefix));
const processes = markedProcessIds();
const failures = [];
if (exit.code !== 143 || exit.signal !== null) {
  failures.push(`runner exit was code=${exit.code} signal=${exit.signal}, expected code=143`);
}
if (processes.length > 0) failures.push(`marked processes remain: ${processes.join(', ')}`);
if (databases.length > 0) {
  failures.push(`isolated databases remain: ${databases.map((row) => row.datname).join(', ')}`);
}
if (reports.length > 0) failures.push(`report directories remain: ${reports.join(', ')}`);
if (failures.length > 0) {
  throw new Error(
    `PostgreSQL runner interruption cleanup failed:\n- ${failures.join('\n- ')}\n${output}`
  );
}

console.log('PostgreSQL runner interruption cleanup passed (processes, databases, reports).');
