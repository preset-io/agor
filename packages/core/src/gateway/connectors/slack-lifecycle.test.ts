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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createConnector(): SlackConnector {
    const connector = new SlackConnector({
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
    });
    (
      connector as unknown as {
        web: { auth: { test: () => Promise<{ user_id: string }> } };
      }
    ).web = { auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_TEST' }) } };
    return connector;
  }

  it('cancels pending aggregate work on final release even when disconnect fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connector = createConnector();
    await connector.startListening(vi.fn());
    const client = socketHarness.instances[0];
    client.logger.warn(HEARTBEAT_WARNING);
    client.disconnect.mockRejectedValueOnce(new Error('disconnect-failed'));

    await expect(connector.stopListening()).rejects.toThrow('disconnect-failed');
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

    socketHarness.instances[0].logger.warn(HEARTBEAT_WARNING);
    socketHarness.instances[1].logger.warn(HEARTBEAT_WARNING);
    await firstConnector.stopListening();
    vi.advanceTimersByTime(10_000);

    expect(warnSpy.mock.calls).toEqual([
      [
        '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=2 warnings=2 window_ms=10000',
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
    vi.advanceTimersByTime(10_000);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await connector.stopListening();
  });
});
