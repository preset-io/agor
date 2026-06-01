import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ExecutorHeartbeatCallbackPayload,
  ExecutorHeartbeatCallbackRunner,
} from './executor-heartbeat-callback';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

class FakeChildProcess extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(),
  });
  kill = vi.fn();
}

const payload: ExecutorHeartbeatCallbackPayload = {
  event: 'executor_heartbeat',
  task_id: '018f0000-0000-7000-8000-000000000001',
  session_id: '018f0000-0000-7000-8000-000000000002',
  last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
};

function createRunner(
  overrides: Partial<ConstructorParameters<typeof ExecutorHeartbeatCallbackRunner>[0]> = {}
) {
  return new ExecutorHeartbeatCallbackRunner({
    enabled: true,
    callback: {
      command_template: 'cat >/dev/null',
      timeout_ms: 100,
    },
    ...overrides,
  });
}

describe('ExecutorHeartbeatCallbackRunner', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('does not spawn callbacks when heartbeat callbacks are disabled', () => {
    const runner = createRunner({ enabled: false });

    runner.run(payload);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps callback coalesced after timeout until the process exits', () => {
    vi.useFakeTimers();
    const firstChild = new FakeChildProcess();
    const secondChild = new FakeChildProcess();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const runner = createRunner();

    runner.run(payload);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');

    runner.run(payload);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    firstChild.emit('exit', null, 'SIGTERM');
    runner.run(payload);

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('handles stdin stream errors as non-fatal callback warnings', () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const runner = createRunner();

    runner.run(payload);
    child.stdin.emit('error', new Error('EPIPE'));
    child.emit('exit', 0, null);

    expect(warnSpy).toHaveBeenCalledWith('[executor-heartbeat] Callback stdin failed: EPIPE');
  });
});
