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

    expect(runner.isConfigured()).toBe(false);
    runner.run(payload);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports whether a callback command is configured', () => {
    expect(createRunner().isConfigured()).toBe(true);
    expect(
      createRunner({ callback: { command_template: '', timeout_ms: 100 } }).isConfigured()
    ).toBe(false);
  });

  it('keeps reserved launcher credentials in the trusted heartbeat helper only', () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const originalEnvironment = process.env;
    const launcherCredentials = {
      AGOR_CLOUD_API_BASE_URL: 'https://synthetic-heartbeat.invalid/api',
      AGOR_CLOUD_RUNTIME_CREDENTIAL_ID: 'synthetic-heartbeat-credential-id',
      AGOR_CLOUD_RUNTIME_SIGNING_KEY: 'synthetic-heartbeat-signing-key',
      AGOR_CLOUD_FUTURE_HELPER_CREDENTIAL: 'synthetic-future-helper-credential',
    } as const;
    const withheldDaemonEnvironment = {
      DATABASE_URL: 'postgres://synthetic-daemon.invalid/agor',
      AGOR_MASTER_SECRET: 'synthetic-deployment-master-secret',
      AGOR_JWT_SECRET: 'synthetic-daemon-jwt-secret',
      OPENAI_API_KEY: 'synthetic-openai-provider-credential',
      ANTHROPIC_API_KEY: 'synthetic-anthropic-provider-credential',
      SYNTHETIC_DAEMON_INTERNAL_SECRET: 'synthetic-unknown-daemon-secret',
    } as const;
    process.env = {
      ...originalEnvironment,
      ...launcherCredentials,
      ...withheldDaemonEnvironment,
      // Exercise the real Object.entries(process.env) boundary with a key that
      // exists but has no value; it must not become a child-env property.
      AGOR_CLOUD_UNDEFINED_CREDENTIAL: undefined,
    };
    try {
      createRunner({
        callback: {
          command_template: '/opt/agor-cloud/bin/agor-cloud-executor-launch heartbeat',
          timeout_ms: 100,
        },
      }).run(payload);
      expect(spawnMock).toHaveBeenCalledWith(
        'sh',
        ['-c', '/opt/agor-cloud/bin/agor-cloud-executor-launch heartbeat'],
        expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
      );
      const options = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
      expect(options.env.PATH).toBe(process.env.PATH);
      expect(options.env).toMatchObject(launcherCredentials);
      expect(options.env).not.toHaveProperty('AGOR_CLOUD_UNDEFINED_CREDENTIAL');

      for (const name of Object.keys(withheldDaemonEnvironment)) {
        expect(options.env, `${name} reached the heartbeat helper`).not.toHaveProperty(name);
      }

      const serializedPayload = String(child.stdin.end.mock.calls[0]?.[0]);
      expect(JSON.parse(serializedPayload)).toEqual(payload);
      for (const value of [
        ...Object.values(launcherCredentials),
        ...Object.values(withheldDaemonEnvironment),
      ]) {
        expect(serializedPayload).not.toContain(value);
      }

      child.emit('exit', 1, null);
      expect(warnSpy).toHaveBeenCalledWith('[executor-heartbeat] Callback exited with code 1');
      const warningOutput = warnSpy.mock.calls.flat().join(' ');
      for (const value of Object.values(launcherCredentials)) {
        expect(warningOutput).not.toContain(value);
      }
    } finally {
      process.env = originalEnvironment;
    }
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
