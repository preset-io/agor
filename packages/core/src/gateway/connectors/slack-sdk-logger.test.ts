import { LogLevel } from '@slack/socket-mode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireSlackSdkLogger } from './slack-sdk-logger';

const HEARTBEAT_WARNING = "A pong wasn't received from the server before the timeout of 5000ms!";

describe('Slack SDK logger', () => {
  const releases: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const release of releases.splice(0)) release();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function acquireLogger() {
    const handle = acquireSlackSdkLogger();
    releases.push(handle.release);
    return handle.logger;
  }

  it('emits one safe summary for a synchronized heartbeat-timeout burst', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstClient = acquireLogger();
    const secondClient = acquireLogger();
    const sentinels = [
      'logger-name-sensitive',
      'string-sensitive\nmultiline-sensitive',
      'https://example.invalid/path?token=xapp-token-sensitive',
      '{"payload":"payload-sensitive"}',
      'object-sensitive',
      'error-sensitive',
    ];
    firstClient.setName(sentinels[0]);

    firstClient.warn(
      HEARTBEAT_WARNING,
      sentinels[1],
      sentinels[2],
      sentinels[3],
      { detail: sentinels[4] },
      new Error(sentinels[5])
    );
    firstClient.warn(HEARTBEAT_WARNING);
    secondClient.warn(HEARTBEAT_WARNING);
    vi.advanceTimersByTime(10_000);

    expect(warnSpy.mock.calls).toEqual([
      [
        '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=2 warnings=3 window_ms=10000',
      ],
    ]);
    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).not.toContain(HEARTBEAT_WARNING);
    for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
  });

  it('maps every SDK level to one safe finite category without retaining raw arguments', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = acquireLogger();
    const sentinels = [
      'hostile-logger-name',
      'hostile-string\nhostile-multiline',
      'https://example.invalid/?token=xoxb-hostile-token',
      '{"event":"hostile-payload"}',
      'hostile-object',
      'hostile-error',
    ];
    const args = [
      sentinels[1],
      sentinels[2],
      sentinels[3],
      { nested: sentinels[4] },
      new Error(sentinels[5]),
    ];

    logger.setName(sentinels[0]);
    logger.setLevel(LogLevel.DEBUG);
    logger.debug(...args);
    logger.info(...args);
    logger.warn(...args);
    logger.error(...args);

    expect(debugSpy.mock.calls).toEqual([['[slack.socket_mode] sdk_debug category=sdk_debug']]);
    expect(infoSpy.mock.calls).toEqual([['[slack.socket_mode] sdk_info category=sdk_info']]);
    expect(warnSpy.mock.calls).toEqual([['[slack.socket_mode] sdk_warning category=sdk_warning']]);
    expect(errorSpy.mock.calls).toEqual([['[slack.socket_mode] sdk_error category=sdk_error']]);
    const output = [debugSpy, infoSpy, warnSpy, errorSpy]
      .flatMap((spy) => spy.mock.calls.flat())
      .join(' ');
    for (const sentinel of sentinels) expect(output).not.toContain(sentinel);

    logger.setLevel(LogLevel.ERROR);
    logger.warn('suppressed-hostile-warning');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('caps warning and distinct-client state, then resets for the next window', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clients = Array.from({ length: 1_001 }, () => acquireLogger());

    for (const client of clients) client.warn(HEARTBEAT_WARNING);
    vi.advanceTimersByTime(10_000);

    expect(warnSpy).toHaveBeenNthCalledWith(
      1,
      '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=100+ warnings=1000+ window_ms=10000'
    );

    clients[0].warn(HEARTBEAT_WARNING);
    vi.advanceTimersByTime(10_000);
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=1 warnings=1 window_ms=10000'
    );
  });
});
