import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorCleanupContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { runExecutorCleanupCommand } from './executor-cleanup-command';

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
