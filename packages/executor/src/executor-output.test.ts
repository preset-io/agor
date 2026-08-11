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

  it('force-exits past a lingering handle instead of hanging', async () => {
    const modulePath = fileURLToPath(new URL('./executor-output.ts', import.meta.url));
    const payload = 'y'.repeat(256 * 1024);
    // A live setInterval keeps the event loop alive forever — it stands in for the
    // Feathers/socket.io client a one-shot command leaves open. Before the force-exit
    // in completeExecutorResult, setting process.exitCode alone left the process hanging
    // until the daemon's 60s kill; this asserts it now terminates promptly with the
    // full result intact.
    const script = [
      `import { completeExecutorResult } from ${JSON.stringify(modulePath)};`,
      `setInterval(() => {}, 1000);`,
      `completeExecutorResult({ success: true, data: 'y'.repeat(${payload.length}) });`,
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
      child.once('error', reject);
      child.once('close', resolve);
    });
    const elapsedMs = Date.now() - startedAt;
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    expect(exitCode, stderr).toBe(0);
    // Full result delivered despite the immediate exit...
    expect(stdout.startsWith(EXECUTOR_RESULT_PREFIX)).toBe(true);
    expect(JSON.parse(stdout.slice(EXECUTOR_RESULT_PREFIX.length))).toEqual({
      success: true,
      data: payload,
    });
    // ...and it exited via the flush callback (well under the 5s failsafe, and nowhere
    // near the old 60s hang).
    expect(elapsedMs).toBeLessThan(5000);
  }, 20000);
});
