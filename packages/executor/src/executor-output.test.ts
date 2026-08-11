import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { EXECUTOR_RESULT_PREFIX } from './executor-output.js';

describe('executor result output', () => {
  it('delivers a result larger than the pipe buffer before exiting', async () => {
    const modulePath = fileURLToPath(new URL('./executor-output.ts', import.meta.url));
    const payload = 'x'.repeat(512 * 1024);
    const script = [
      `import { emitExecutorResult } from ${JSON.stringify(modulePath)};`,
      `emitExecutorResult({ success: true, data: 'x'.repeat(${payload.length}) });`,
      'process.exitCode = 0;',
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
});
