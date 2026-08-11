import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXECUTOR_RESULT_PREFIX } from '@agor/core/executor-protocol';
import { describe, expect, it } from 'vitest';

describe('executor result output', () => {
  it('delivers a result larger than the pipe buffer before exiting', async () => {
    const modulePath = fileURLToPath(new URL('./executor-output.ts', import.meta.url));
    const payload = 'x'.repeat(512 * 1024);
    const script = [
      `import { completeExecutorResult } from ${JSON.stringify(modulePath)};`,
      `completeExecutorResult({ success: true, data: 'x'.repeat(${payload.length}) });`,
    ].join('\n');

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    expect(exitCode, stderr).toBe(0);
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.startsWith(EXECUTOR_RESULT_PREFIX)).toBe(true);
    expect(JSON.parse(stdout.slice(EXECUTOR_RESULT_PREFIX.length))).toEqual({
      success: true,
      data: payload,
    });
  });

  it('force-exits after flushing even when a handle keeps the event loop alive', async () => {
    const modulePath = fileURLToPath(new URL('./executor-output.ts', import.meta.url));
    const script = [
      `import { completeExecutorResult } from ${JSON.stringify(modulePath)};`,
      'setInterval(() => {}, 1_000_000);',
      `completeExecutorResult({ success: true, data: 'complete' });`,
    ].join('\n');
    const startedAt = Date.now();

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Executor child did not force-exit after flushing stdout'));
      }, 5000);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    expect(exitCode, stderr).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(stdout).toBe(`${EXECUTOR_RESULT_PREFIX}{"success":true,"data":"complete"}\n`);
  });
});
