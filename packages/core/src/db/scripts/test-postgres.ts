#!/usr/bin/env node

/**
 * Run every PostgreSQL integration test against its own temporary database.
 *
 * Several suites deliberately create or alter fixed catalog objects. Running
 * those files concurrently in one database is unsafe, but serializing every
 * file makes the PostgreSQL lane unnecessarily slow. This runner preserves
 * file-level parallelism while isolating each file at the database boundary.
 *
 * The role in AGOR_TEST_POSTGRES_URL must have CREATEDB. PostgreSQL tests use a
 * non-superuser, non-BYPASSRLS role so their tenant-isolation assertions remain
 * meaningful.
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const testRoot = join(packageRoot, 'src');
const defaultConcurrency = 3;
const maxConcurrency = 8;

async function findPostgresTests(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findPostgresTests(path);
      return entry.isFile() && entry.name.endsWith('.postgres.test.ts') ? [path] : [];
    })
  );
  return files.flat().sort();
}

function resolveConcurrency(): number {
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

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function runTestFile(file: string, url: string): Promise<number> {
  const displayName = basename(file);
  const relativeFile = relative(packageRoot, file);
  console.log(`\n[postgres:${displayName}] starting`);
  return new Promise<number>((resolveRun, rejectRun) => {
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const child = spawn(command, ['exec', 'vitest', 'run', relativeFile], {
      cwd: packageRoot,
      env: {
        ...process.env,
        AGOR_DB_DIALECT: 'postgresql',
        AGOR_TEST_POSTGRES_URL: url,
      },
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`[postgres:${displayName}] terminated by ${signal}`);
        resolveRun(1);
        return;
      }
      const exitCode = code ?? 1;
      console.log(`[postgres:${displayName}] ${exitCode === 0 ? 'passed' : 'failed'}`);
      resolveRun(exitCode);
    });
  });
}

async function main(): Promise<void> {
  const baseUrl = process.env.AGOR_TEST_POSTGRES_URL?.trim();
  if (!baseUrl) {
    throw new Error('AGOR_TEST_POSTGRES_URL is required');
  }
  const postgresUrl = baseUrl;
  const parsedUrl = new URL(postgresUrl);
  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('AGOR_TEST_POSTGRES_URL must be a PostgreSQL URL');
  }

  const files = await findPostgresTests(testRoot);
  if (files.length === 0) throw new Error('No *.postgres.test.ts files found');

  const concurrency = Math.min(resolveConcurrency(), files.length);
  const runId = `${Date.now().toString(36)}_${process.pid.toString(36)}`;
  const control = postgres(postgresUrl, { max: 1 });
  const results = new Array<number>(files.length);
  let nextIndex = 0;

  console.log(`Running ${files.length} PostgreSQL test files with concurrency ${concurrency}`);

  async function worker(): Promise<void> {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      const file = files[index];
      if (!file) throw new Error(`Missing PostgreSQL test file at index ${index}`);
      const databaseName = `agor_test_${runId}_${index}`;
      const isolatedUrl = databaseUrl(postgresUrl, databaseName);
      try {
        await control.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
        results[index] = await runTestFile(file, isolatedUrl);
      } catch (error) {
        results[index] = 1;
        console.error(
          `[postgres:${basename(file)}] ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        try {
          await control.unsafe(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
          );
        } catch (error) {
          results[index] = 1;
          console.error(
            `[postgres:${basename(file)}] cleanup failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    await control.end();
  }

  const failures = results.filter((code) => code !== 0).length;
  if (failures > 0) {
    throw new Error(`${failures} of ${files.length} PostgreSQL test files failed`);
  }
  console.log(`\nAll ${files.length} PostgreSQL test files passed`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
