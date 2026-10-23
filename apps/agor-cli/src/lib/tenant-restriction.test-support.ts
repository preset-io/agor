/** Test-only: spawn the real CLI as an in-Cell Job does; lives outside `src/commands` so oclif never loads it. */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const cliRoot = resolve(import.meta.dirname, '../..');
const COMMAND_TIMEOUT_MS = 30_000;

export interface TenantRestrictionCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runner variables that could otherwise let a test pass without the Job's database configuration. */
const DATABASE_ENV_TO_CLEAR = [
  'AGOR_DB_DIALECT',
  'AGOR_DB_PATH',
  'AGOR_TEST_POSTGRES_URL',
  'AGOR_TEST_POSTGRES_ADMIN_URL',
  'DATABASE_URL',
] as const;

/** Run `agor tenant restriction <args>` with an explicit environment. */
export function runTenantRestrictionCli(
  args: string[],
  env: Record<string, string> = {}
): Promise<TenantRestrictionCliResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of DATABASE_ENV_TO_CLEAR) delete childEnv[name];
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'bin/dev.ts', 'tenant', 'restriction', ...args],
      {
        cwd: cliRoot,
        env: {
          ...childEnv,
          ...env,
          NO_COLOR: '1',
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, COMMAND_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      if (timedOut) {
        reject(new Error(`agor tenant restriction ${args.join(' ')} timed out`));
        return;
      }
      resolveRun({ code, stdout, stderr });
    });
  });
}
