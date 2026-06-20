import type { TaskID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentProgressWatchdog } from './agent-progress-watchdog.js';

function makeClient() {
  const patch = vi.fn(async () => ({}));
  return {
    client: {
      service(name: string) {
        if (name !== 'tasks') {
          throw new Error(`unexpected service ${name}`);
        }
        return { patch };
      },
    },
    patch,
  };
}

function createWatchdog(options?: {
  firstProgressTimeoutMs?: number;
  idleProgressTimeoutMs?: number;
  checkIntervalMs?: number;
}) {
  const { client, patch } = makeClient();
  const abortController = new AbortController();
  const watchdog = new AgentProgressWatchdog({
    client: client as never,
    taskId: 'task-1' as TaskID,
    toolName: 'codex',
    abortController,
    firstProgressTimeoutMs: options?.firstProgressTimeoutMs ?? 1000,
    idleProgressTimeoutMs: options?.idleProgressTimeoutMs ?? 2000,
    checkIntervalMs: options?.checkIntervalMs ?? 100,
  });

  return { watchdog, patch, abortController };
}

describe('AgentProgressWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails and aborts when the SDK turn never produces progress', async () => {
    const { watchdog, patch, abortController } = createWatchdog();

    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(watchdog.hasStalled()).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(patch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('no agent progress within 1000ms'),
        metadata: {
          agent_progress_watchdog: expect.objectContaining({
            status: 'stalled',
            first_progress_seen: false,
            timeout_ms: 1000,
          }),
        },
      })
    );
  });

  it('uses the idle timeout after progress has been observed', async () => {
    const { watchdog, patch, abortController } = createWatchdog({
      firstProgressTimeoutMs: 1000,
      idleProgressTimeoutMs: 1500,
    });

    watchdog.start();
    watchdog.markAgentProgress('task-stream:tool:start');

    await vi.advanceTimersByTimeAsync(1400);
    expect(patch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(abortController.signal.aborted).toBe(true);
    expect(patch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        error_message: expect.stringContaining('after task-stream:tool:start'),
        metadata: {
          agent_progress_watchdog: expect.objectContaining({
            first_progress_seen: true,
            last_progress_label: 'task-stream:tool:start',
            timeout_ms: 1500,
          }),
        },
      })
    );
  });

  it('keeps running when progress refreshes before the idle timeout', async () => {
    const { watchdog, patch } = createWatchdog({
      firstProgressTimeoutMs: 1000,
      idleProgressTimeoutMs: 1000,
    });

    watchdog.start();
    watchdog.markAgentProgress('stream:start');

    await vi.advanceTimersByTimeAsync(900);
    watchdog.markAgentProgress('stream:chunk');
    await vi.advanceTimersByTimeAsync(900);

    expect(watchdog.hasStalled()).toBe(false);
    expect(patch).not.toHaveBeenCalled();

    watchdog.stop();
  });

  it('does not treat local activity as first agent progress', async () => {
    const { watchdog, patch, abortController } = createWatchdog({
      firstProgressTimeoutMs: 1000,
      idleProgressTimeoutMs: 5000,
    });

    watchdog.start();
    watchdog.markActivity('message-service:create:user');

    await vi.advanceTimersByTimeAsync(1000);

    expect(abortController.signal.aborted).toBe(true);
    expect(patch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        error_message: expect.stringContaining('no agent progress within 1000ms'),
        metadata: {
          agent_progress_watchdog: expect.objectContaining({
            first_progress_seen: false,
            last_activity_label: 'message-service:create:user',
          }),
        },
      })
    );
  });
});
