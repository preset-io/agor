import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createExecutorWorkloadHandle,
  EXECUTOR_ATTEMPT_ENV_VAR,
  EXECUTOR_TERMINATION_REASONS,
  isProcessAlive,
  parseProcessTable,
} from './executor-workload.js';

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('executor workload', () => {
  it('maps descendants from the portable process table shape', () => {
    expect(parseProcessTable('  10  1\n  11  10\ninvalid\n')).toEqual([
      { pid: 10, parentPid: 1 },
      { pid: 11, parentPid: 10 },
    ]);
  });

  it('treats a permission-denied liveness probe as still alive', () => {
    const error = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });

    expect(isProcessAlive(123)).toBe(true);
    kill.mockRestore();
  });

  it('does not signal an empty process group after normal completion', async () => {
    if (process.platform === 'win32') return;

    const launcher = spawn(process.execPath, ['-e', ''], {
      detached: true,
      stdio: 'ignore',
    });
    const workload = createExecutorWorkloadHandle(launcher)!;
    await once(launcher, 'exit');
    const kill = vi.spyOn(process, 'kill');

    try {
      await workload.finish();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('does not verify finish while the executor root is still alive', async () => {
    if (process.platform === 'win32') return;

    const launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const workload = createExecutorWorkloadHandle(launcher, { gracePeriodMs: 100 })!;

    try {
      await workload.finish();
      expect(processExists(launcher.pid!)).toBe(false);
    } finally {
      if (launcher.pid && processExists(launcher.pid)) process.kill(-launcher.pid, 'SIGKILL');
    }
  });

  it('force-kills a TERM-resistant descendant that created its own process group', async () => {
    if (process.platform === 'win32') return;

    const childScript = `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    const parentScript = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {
        detached: true,
        stdio: 'ignore',
      });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ['-e', parentScript], {
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const workload = createExecutorWorkloadHandle(parent, { gracePeriodMs: 100 });
    expect(workload).not.toBeNull();

    const [chunk] = (await once(parent.stdout!, 'data')) as [Buffer];
    const childPid = Number(chunk.toString().trim());

    try {
      const first = workload!.terminate(EXECUTOR_TERMINATION_REASONS.USER_STOP);
      const second = workload!.terminate(EXECUTOR_TERMINATION_REASONS.HEARTBEAT_LOST);
      expect(second).toBe(first);
      await first;
      await Promise.race([
        once(parent, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);

      expect(processExists(parent.pid!)).toBe(false);
      expect(processExists(childPid)).toBe(false);
    } finally {
      if (parent.pid && processExists(parent.pid)) process.kill(-parent.pid, 'SIGKILL');
      if (processExists(childPid)) process.kill(childPid, 'SIGKILL');
    }
  });

  it('cleans a marked, reparented process after normal executor completion', async () => {
    if (process.platform !== 'linux') return;

    const attemptId = 'attempt-reparented';
    const detachedScript = `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    const launcherScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(detachedScript)}], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      console.log(child.pid);
      child.unref();
    `;
    const launcher = spawn(process.execPath, ['-e', launcherScript], {
      detached: true,
      env: { ...process.env, [EXECUTOR_ATTEMPT_ENV_VAR]: attemptId },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const workload = createExecutorWorkloadHandle(launcher, {
      attemptId,
      gracePeriodMs: 100,
    });
    const launcherExit = once(launcher, 'exit');
    expect(workload).not.toBeNull();

    const [chunk] = (await once(launcher.stdout!, 'data')) as [Buffer];
    const detachedPid = Number(chunk.toString().trim());
    await launcherExit;

    try {
      expect(processExists(detachedPid)).toBe(true);
      await workload!.finish();
      expect(processExists(detachedPid)).toBe(false);
    } finally {
      if (processExists(detachedPid)) process.kill(detachedPid, 'SIGKILL');
    }
  });

  it('force-kills a TERM-resistant process left in the executor group on finish', async () => {
    if (process.platform === 'win32') return;

    const childScript = `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    const launcherScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {
        stdio: 'ignore',
      });
      console.log(child.pid);
      child.unref();
    `;
    const launcher = spawn(process.execPath, ['-e', launcherScript], {
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const workload = createExecutorWorkloadHandle(launcher, { gracePeriodMs: 100 });
    const launcherExit = once(launcher, 'exit');
    const [chunk] = (await once(launcher.stdout!, 'data')) as [Buffer];
    const childPid = Number(chunk.toString().trim());
    await launcherExit;

    try {
      await workload!.finish();
      expect(processExists(childPid)).toBe(false);
    } finally {
      if (processExists(childPid)) process.kill(childPid, 'SIGKILL');
    }
  });

  it('runs remote cleanup exactly once when a templated workload finishes', async () => {
    const launcher = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const remoteStop = vi.fn(async () => undefined);
    const workload = createExecutorWorkloadHandle(launcher, { remoteStop })!;
    await once(launcher, 'exit');
    const cleanup = workload.finish();
    expect(workload.terminate(EXECUTOR_TERMINATION_REASONS.USER_STOP)).toBe(cleanup);
    await cleanup;
    expect(remoteStop).toHaveBeenCalledOnce();
    expect(remoteStop).toHaveBeenCalledWith(EXECUTOR_TERMINATION_REASONS.RECONCILIATION);
  });
});
