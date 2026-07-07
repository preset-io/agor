import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstAgentProgressWatchdog } from './first-agent-progress-watchdog.js';

function createWatchdog(options?: {
  firstAgentProgressTimeoutMs?: number;
  checkIntervalMs?: number;
}) {
  const abortController = new AbortController();
  const watchdog = new FirstAgentProgressWatchdog({
    toolName: 'codex',
    abortController,
    firstAgentProgressTimeoutMs: options?.firstAgentProgressTimeoutMs ?? 1000,
    checkIntervalMs: options?.checkIntervalMs ?? 100,
  });

  return { watchdog, abortController };
}

describe('FirstAgentProgressWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts when the SDK turn never produces first agent progress', async () => {
    const { watchdog, abortController } = createWatchdog();

    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(watchdog.hasStalled()).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(watchdog.getStallReason()).toContain('no first meaningful agent event within 1000ms');
    expect(watchdog.getDiagnosticMetadata()).toEqual({
      first_agent_progress_watchdog: expect.objectContaining({
        status: 'stalled',
        watchdog_started_at: '2026-06-20T00:00:00.000Z',
        timeout_ms: 1000,
      }),
    });
  });

  it('stops watching after first agent progress', async () => {
    const { watchdog, abortController } = createWatchdog({
      firstAgentProgressTimeoutMs: 1000,
    });

    watchdog.start();
    watchdog.markAgentProgress('stream:start');
    await vi.advanceTimersByTimeAsync(5000);

    expect(watchdog.hasStalled()).toBe(false);
    expect(abortController.signal.aborted).toBe(false);
  });

  it('does not fire after it is stopped', async () => {
    const { watchdog, abortController } = createWatchdog({
      firstAgentProgressTimeoutMs: 1000,
    });

    watchdog.start();
    watchdog.markAgentProgress('stream:end');

    await vi.advanceTimersByTimeAsync(900);
    watchdog.stop();
    await vi.advanceTimersByTimeAsync(200);

    expect(watchdog.hasStalled()).toBe(false);
    expect(abortController.signal.aborted).toBe(false);
  });

  it('does not treat local activity as first agent progress', async () => {
    const { watchdog, abortController } = createWatchdog({
      firstAgentProgressTimeoutMs: 1000,
    });

    watchdog.start();
    watchdog.markActivity('message-service:create:user');

    await vi.advanceTimersByTimeAsync(1000);

    expect(abortController.signal.aborted).toBe(true);
    expect(watchdog.getDiagnosticMetadata()).toEqual({
      first_agent_progress_watchdog: expect.objectContaining({
        last_activity_label: 'message-service:create:user',
      }),
    });
  });

  it('pauses while permission owns the wait and resumes afterward', async () => {
    const { watchdog, abortController } = createWatchdog({
      firstAgentProgressTimeoutMs: 1000,
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(900);
    watchdog.pause('task:awaiting_permission');
    await vi.advanceTimersByTimeAsync(5000);

    expect(watchdog.hasStalled()).toBe(false);
    expect(abortController.signal.aborted).toBe(false);

    watchdog.resume('task:running');
    await vi.advanceTimersByTimeAsync(1000);

    expect(watchdog.hasStalled()).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
  });

  it('can be disabled with a zero timeout', async () => {
    const { watchdog, abortController } = createWatchdog({
      firstAgentProgressTimeoutMs: 0,
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(watchdog.hasStalled()).toBe(false);
    expect(abortController.signal.aborted).toBe(false);
  });
});
