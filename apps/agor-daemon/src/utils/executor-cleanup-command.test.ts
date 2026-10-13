import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorCleanupContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CLEANUP_RESULT_BYTES,
  parseExecutorCleanupResult,
  runExecutorCleanupCommand,
} from './executor-cleanup-command';

const context: ExecutorCleanupContext = {
  version: 1,
  tenant_id: 'tenant-a',
  task_id: 'task-a',
  session_id: 'session-a',
  branch_id: 'branch-a',
  requested_at: '2026-10-05T00:00:00Z',
  attempt_id: 'attempt-a',
  cause: 'heartbeat_lost',
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;

describe('bounded external cleanup command', () => {
  it('passes exact tenant/task context on stdin, never as shell syntax', async () => {
    const value = { ...context, branch_id: "branch'; exit 7; #" };
    const result = await runExecutorCleanupCommand(
      node(
        `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const x=JSON.parse(input);process.exit(x.tenant_id==='tenant-a' && x.branch_id===${JSON.stringify(value.branch_id)} ? 0 : 1)})`
      ),
      value
    );
    expect(result.confirmed).toBe(true);
  });
  it.each([1, 137, 143])('does not treat exit %s as containment or OOM evidence', async (code) => {
    const result = await runExecutorCleanupCommand(node(`process.exit(${code})`), context);
    expect(result.confirmed).toBe(false);
    expect(result.diagnostic).not.toContain('OOM');
  });
  it('treats a signaled disposable child as unknown', async () => {
    expect(
      (
        await runExecutorCleanupCommand(
          `exec ${node("process.kill(process.pid, 'SIGKILL')")}`,
          context
        )
      ).confirmed
    ).toBe(false);
  });
  it.skipIf(process.platform !== 'linux')(
    'bounds a hanging helper and stops its owned descendant',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'agor-cleanup-test-'));
      const pidFile = join(directory, 'child-pid');
      try {
        const started = Date.now();
        // Only this disposable child's PID is inspected. No production/self processes are signaled.
        const result = await runExecutorCleanupCommand(
          node(
            `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`
          ),
          context,
          1000
        );
        expect(result).toEqual({ confirmed: false, diagnostic: 'Cleanup timed out.' });
        expect(Date.now() - started).toBeLessThan(5000);
        const pid = Number(readFileSync(pidFile, 'utf8'));
        expect(pid).toBeGreaterThan(1);
        await vi.waitFor(() => {
          let state: string | undefined;
          try {
            state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          // A reaping delay is not ongoing SDK execution; never mistake a live descendant for cleanup.
          expect(state === undefined || state === 'Z').toBe(true);
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
  it('does not expose daemon secrets or command output in diagnostics', async () => {
    process.env.AGOR_CLEANUP_TEST_SECRET = 'do-not-leak';
    try {
      const result = await runExecutorCleanupCommand(
        node(
          "console.error('arbitrary sensitive diagnostic');process.exit(process.env.AGOR_CLEANUP_TEST_SECRET ? 4 : 0)"
        ),
        context
      );
      expect(result.confirmed).toBe(true);
      expect(result.diagnostic).not.toContain('sensitive');
    } finally {
      delete process.env.AGOR_CLEANUP_TEST_SECRET;
    }
  });
  it('reports missing commands as unknown', async () => {
    expect(
      (await runExecutorCleanupCommand('/nonexistent-agor-cleanup-test', context)).confirmed
    ).toBe(false);
  });
});

describe('optional cleanup result on stdout', () => {
  const GIB = 1024 ** 3;
  const print = (text: string, code = 0) =>
    node(`process.stdout.write(${JSON.stringify(text)});process.exitCode=${code}`);

  it('keeps today’s behavior when the helper prints nothing', async () => {
    expect(await runExecutorCleanupCommand(node('process.exit(0)'), context)).toEqual({
      confirmed: true,
      diagnostic: 'Cleanup command exited with code 0.',
    });
  });
  it('reports an out-of-memory cause with its limit', async () => {
    const line = JSON.stringify({
      version: 1,
      contained: true,
      cause: 'oom_killed',
      memoryLimitBytes: 6 * GIB,
    });
    expect(await runExecutorCleanupCommand(print(`${line}\n`), context)).toEqual({
      confirmed: true,
      diagnostic: 'Cleanup command exited with code 0.',
      cause: 'oom_killed',
      memoryLimitBytes: 6 * GIB,
    });
  });
  it('reports an out-of-memory cause without a limit', async () => {
    const result = await runExecutorCleanupCommand(
      print('{"version":1,"contained":true,"cause":"oom_killed"}\n'),
      context
    );
    expect(result).toMatchObject({ confirmed: true, cause: 'oom_killed' });
    expect(result).not.toHaveProperty('memoryLimitBytes');
  });
  it.each([
    ['unparseable output', 'not json\n'],
    ['a truncated line', '{"version":1,"contained":true,"cause":"oom_kil'],
    ['an unknown version', '{"version":2,"contained":true,"cause":"oom_killed"}'],
    ['a result without a cause', '{"version":1,"contained":true}'],
  ])('ignores %s and stays confirmed', async (_name, text) => {
    expect(await runExecutorCleanupCommand(print(text), context)).toEqual({
      confirmed: true,
      diagnostic: 'Cleanup command exited with code 0.',
    });
  });
  it.each([1, 137])('never reads a cause from a nonzero exit (%s)', async (code) => {
    const result = await runExecutorCleanupCommand(
      print('{"version":1,"contained":true,"cause":"oom_killed","memoryLimitBytes":1024}\n', code),
      context
    );
    expect(result).toEqual({
      confirmed: false,
      diagnostic: `Cleanup command exited with code ${code}.`,
    });
  });
  it('drains and ignores output longer than the result bound', async () => {
    const line = JSON.stringify({ version: 1, contained: true, cause: 'oom_killed' });
    const result = await runExecutorCleanupCommand(
      node(
        `process.stdout.write(${JSON.stringify(line)}+' '.repeat(${MAX_CLEANUP_RESULT_BYTES * 32}))`
      ),
      context
    );
    expect(result).toEqual({
      confirmed: true,
      diagnostic: 'Cleanup command exited with code 0.',
    });
  });
  // A background descendant inherits stdout, so the pipe stays open past exit 0.
  it('confirms on exit 0 without waiting for a descendant holding stdout', async () => {
    const started = Date.now();
    expect(await runExecutorCleanupCommand('(sleep 3 &); exit 0', context, 10_000)).toEqual({
      confirmed: true,
      diagnostic: 'Cleanup command exited with code 0.',
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('ignores a result whose stdout is still held open after the grace period', async () => {
    const line = JSON.stringify({ version: 1, contained: true, cause: 'oom_killed' });
    const started = Date.now();
    expect(
      await runExecutorCleanupCommand(`echo ${quote(line)}; (sleep 3 &); exit 0`, context, 10_000)
    ).toEqual({ confirmed: true, diagnostic: 'Cleanup command exited with code 0.' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('keeps an exit 0 observed just before the deadline confirmed', async () => {
    // Exit lands well before the deadline; the busy-wait alone forces the race.
    const timeoutMs = 1000;
    const started = Date.now();
    const realSetTimeout = globalThis.setTimeout;
    let forced = false;
    // Hold the loop past the deadline as the grace timer is armed, so the main
    // timeout is already due; it must no longer override the observed exit.
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number
    ) => {
      if (callback.name === 'finishWithOutput') {
        forced = true;
        while (Date.now() - started < timeoutMs + 50) {
          /* Busy-wait. */
        }
      }
      return realSetTimeout(callback, ms);
    }) as typeof setTimeout);
    try {
      expect(await runExecutorCleanupCommand('(sleep 3 &); exit 0', context, timeoutMs)).toEqual({
        confirmed: true,
        diagnostic: 'Cleanup command exited with code 0.',
      });
      // Fails loudly if the grace callback is renamed and the race is never forced.
      expect(forced).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('parseExecutorCleanupResult', () => {
  const valid = { version: 1, contained: true, cause: 'oom_killed' };
  it.each([
    ['empty', ''],
    ['two lines', `${JSON.stringify(valid)}\n${JSON.stringify(valid)}`],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string version', JSON.stringify({ ...valid, version: '1' })],
    ['an uncontained result', JSON.stringify({ ...valid, contained: false })],
    ['an unknown cause', JSON.stringify({ ...valid, cause: 'crashed' })],
    ['a zero limit', JSON.stringify({ ...valid, memoryLimitBytes: 0 })],
    ['a negative limit', JSON.stringify({ ...valid, memoryLimitBytes: -1 })],
    ['a fractional limit', JSON.stringify({ ...valid, memoryLimitBytes: 1.5 })],
    ['a string limit', JSON.stringify({ ...valid, memoryLimitBytes: '6442450944' })],
    [
      'an unsafe limit',
      `{"version":1,"contained":true,"cause":"oom_killed","memoryLimitBytes":${2 ** 53}}`,
    ],
  ])('has no cause for %s', (_name, text) => {
    expect(parseExecutorCleanupResult(text)).toEqual({});
  });
  it('tolerates unknown fields', () => {
    expect(
      parseExecutorCleanupResult(JSON.stringify({ ...valid, memoryLimitBytes: 512, extra: 'x' }))
    ).toEqual({ cause: 'oom_killed', memoryLimitBytes: 512 });
  });
});
