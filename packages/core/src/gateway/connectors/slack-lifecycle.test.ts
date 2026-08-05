import type { Logger } from '@slack/socket-mode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HEARTBEAT_WARNING = "A pong wasn't received from the server before the timeout of 5000ms!";

const socketHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    logger: Logger;
    start: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  warnOnStart: false,
  startError: null as Error | null,
}));

const loggerHarness = vi.hoisted(() => ({ acquisitions: 0 }));

vi.mock('./slack-sdk-logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./slack-sdk-logger')>();
  return {
    ...actual,
    acquireSlackSdkLogger: () => {
      loggerHarness.acquisitions++;
      return actual.acquireSlackSdkLogger();
    },
  };
});

vi.mock('@slack/socket-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slack/socket-mode')>();
  class FakeSocketModeClient {
    readonly logger: Logger;
    readonly on = vi.fn();
    readonly start = vi.fn(async () => {
      if (socketHarness.warnOnStart) this.logger.warn(HEARTBEAT_WARNING);
      if (socketHarness.startError) throw socketHarness.startError;
    });
    readonly disconnect = vi.fn(async () => {});

    constructor(options: { logger: Logger }) {
      this.logger = options.logger;
      socketHarness.instances.push(this);
    }
  }
  return { ...actual, SocketModeClient: FakeSocketModeClient };
});

import { SlackConnector } from './slack';

describe('SlackConnector SDK logger lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socketHarness.instances.length = 0;
    socketHarness.warnOnStart = false;
    socketHarness.startError = null;
    loggerHarness.acquisitions = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createConnector(
    authTest: () => Promise<{ user_id: string }> = vi.fn().mockResolvedValue({ user_id: 'U_TEST' })
  ): SlackConnector {
    const connector = new SlackConnector({
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
    });
    (
      connector as unknown as {
        web: { auth: { test: () => Promise<{ user_id: string }> } };
      }
    ).web = { auth: { test: authTest } };
    return connector;
  }

  it('rejects sequential double-start before acquiring another logger or client', async () => {
    const connector = createConnector();
    await connector.startListening(vi.fn());

    await expect(connector.startListening(vi.fn())).rejects.toThrow(
      'Slack Socket Mode listener is already active'
    );
    expect(loggerHarness.acquisitions).toBe(1);
    expect(socketHarness.instances).toHaveLength(1);

    await connector.stopListening();
    await expect(connector.stopListening()).resolves.toBeUndefined();
    expect(socketHarness.instances[0].disconnect).toHaveBeenCalledOnce();
  });

  it('rejects overlapping double-start before acquiring another logger or client', async () => {
    let resolveAuth: ((value: { user_id: string }) => void) | undefined;
    const authResult = new Promise<{ user_id: string }>((resolve) => {
      resolveAuth = resolve;
    });
    const connector = createConnector(vi.fn(() => authResult));

    const firstStart = connector.startListening(vi.fn());
    await expect(connector.startListening(vi.fn())).rejects.toThrow(
      'Slack Socket Mode listener is already active'
    );
    expect(loggerHarness.acquisitions).toBe(1);
    expect(socketHarness.instances).toHaveLength(1);

    resolveAuth?.({ user_id: 'U_TEST' });
    await firstStart;
    await connector.stopListening();
  });

  it('cancels pending aggregate work on final release even when disconnect fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connector = createConnector();
    await connector.startListening(vi.fn());
    const client = socketHarness.instances[0];
    client.logger.warn(HEARTBEAT_WARNING);
    client.disconnect.mockRejectedValueOnce(new Error('disconnect-failed'));

    await expect(connector.stopListening()).rejects.toThrow('disconnect-failed');
    client.logger.warn(HEARTBEAT_WARNING);
    vi.advanceTimersByTime(10_000);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps aggregate work intact when another production client remains active', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstConnector = createConnector();
    const secondConnector = createConnector();
    await firstConnector.startListening(vi.fn());
    await secondConnector.startListening(vi.fn());

    socketHarness.instances[1].logger.warn(HEARTBEAT_WARNING);
    expect(vi.getTimerCount()).toBe(1);
    await firstConnector.stopListening();
    expect(vi.getTimerCount()).toBe(1);
    socketHarness.instances[0].logger.warn(HEARTBEAT_WARNING);
    socketHarness.instances[1].logger.warn(HEARTBEAT_WARNING);
    vi.advanceTimersByTime(10_000);

    expect(warnSpy.mock.calls).toEqual([
      [
        '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=1 warnings=2 window_ms=10000',
      ],
    ]);
    await secondConnector.stopListening();
  });

  it('releases pending aggregate work when production startup fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    socketHarness.warnOnStart = true;
    socketHarness.startError = new Error('start-failed');
    const connector = createConnector();

    await expect(connector.startListening(vi.fn())).rejects.toThrow('start-failed');
    socketHarness.instances[0].logger.warn(HEARTBEAT_WARNING);
    vi.advanceTimersByTime(10_000);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await connector.stopListening();
  });
});
