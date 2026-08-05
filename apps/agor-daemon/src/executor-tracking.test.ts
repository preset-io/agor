import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  containExecutorProcess,
  markExecutorProcessExited,
  releaseExecutorContainmentFenceIntent,
  reserveExecutorContainmentFence,
  retainExecutorContainmentFence,
  trackExecutorProcess,
  untrackExecutorProcess,
  verifyExecutorContainmentFence,
} from './executor-tracking.js';

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')(
  'executor process-group containment',
  () => {
    it('kills a process group whose leader and descendant ignore SIGTERM', async () => {
      const script = `
        const { spawn } = require('node:child_process');
        spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
      `;
      const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
      if (!leader.pid) throw new Error('leader PID missing');
      trackExecutorProcess({ sessionId: 'session-tree', taskId: 'task-tree', pid: leader.pid });
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await expect(
          containExecutorProcess('session-tree', 'task-tree', {
            termGraceMs: 50,
            killGraceMs: 1000,
            pollMs: 10,
          })
        ).resolves.toEqual({ status: 'verified_absent' });
      } finally {
        try {
          process.kill(-leader.pid, 'SIGKILL');
        } catch {}
        untrackExecutorProcess('session-tree');
      }
    });

    it('contains a managed nondetached server child after the executor leader exits', async () => {
      const script = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.stdout.once('data', () => process.exit(0));
      `;
      const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
      if (!leader.pid) throw new Error('leader PID missing');
      trackExecutorProcess({ sessionId: 'session-orphan', taskId: 'task-orphan', pid: leader.pid });
      try {
        await once(leader, 'exit');
        markExecutorProcessExited('session-orphan', leader.pid);
        expect(() => process.kill(-leader.pid!, 0)).not.toThrow();

        await expect(
          containExecutorProcess('session-orphan', 'task-orphan', {
            termGraceMs: 50,
            killGraceMs: 1000,
            pollMs: 10,
          })
        ).resolves.toEqual({ status: 'verified_absent' });
        expect(() => process.kill(-leader.pid!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        );
      } finally {
        try {
          process.kill(-leader.pid, 'SIGKILL');
        } catch {}
        untrackExecutorProcess('session-orphan');
      }
    });

    it('fails closed when cross-UID signaling is unavailable', async () => {
      const leader = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      if (!leader.pid) throw new Error('leader PID missing');
      trackExecutorProcess({
        sessionId: 'session-uid',
        taskId: 'task-uid',
        pid: leader.pid,
        asUser: 'agor_executor',
      });
      try {
        await expect(containExecutorProcess('session-uid', 'task-uid')).resolves.toMatchObject({
          status: 'unverified',
        });
      } finally {
        process.kill(-leader.pid, 'SIGKILL');
        untrackExecutorProcess('session-uid');
      }
    });

    it('reconciles a durable containment fence after in-memory tracking is lost', async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-containment-fence-'));
      const leader = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      if (!leader.pid) throw new Error('leader PID missing');
      await once(leader, 'spawn');
      trackExecutorProcess({
        sessionId: 'session-restart',
        taskId: 'task-restart',
        pid: leader.pid,
      });
      try {
        await retainExecutorContainmentFence(
          'opencode-native-state:subject',
          'session-restart',
          'task-restart',
          root
        );
        untrackExecutorProcess('session-restart', 'task-restart');
        const exited = once(leader, 'exit');

        await expect(
          verifyExecutorContainmentFence('opencode-native-state:subject', root)
        ).resolves.toBe(true);
        await exited;
        const [fenceDirectory] = await readdir(root);
        if (!fenceDirectory) throw new Error('containment fence directory missing');
        await expect(readdir(join(root, fenceDirectory))).resolves.toEqual([]);
      } finally {
        try {
          process.kill(-leader.pid, 'SIGKILL');
        } catch {}
        untrackExecutorProcess('session-restart');
        await rm(root, { recursive: true, force: true });
      }
    });

    it('fails closed across restart while a writer has only a durable start intent', async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-containment-intent-'));
      const fenceKey = 'opencode-native-state:pre-writer';
      try {
        const intentId = await reserveExecutorContainmentFence(fenceKey, root);

        await expect(verifyExecutorContainmentFence(fenceKey, root)).resolves.toBe(false);
        const [fenceDirectory] = await readdir(root);
        if (!fenceDirectory) throw new Error('containment intent directory missing');
        await expect(readdir(join(root, fenceDirectory))).resolves.toEqual([
          `intent-${intentId}.json`,
        ]);

        await releaseExecutorContainmentFenceIntent(fenceKey, intentId, root);
        await expect(verifyExecutorContainmentFence(fenceKey, root)).resolves.toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
);
