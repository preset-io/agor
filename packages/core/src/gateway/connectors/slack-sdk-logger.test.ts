import { LogLevel } from '@slack/socket-mode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlackSdkLogger, createSlackSdkLoggerController } from './slack-sdk-logger';

const HEARTBEAT_WARNING = "A pong wasn't received from the server before the timeout of 5000ms!";

describe('Slack SDK logger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits one safe summary for a synchronized heartbeat-timeout burst', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstClient = createSlackSdkLogger();
    const secondClient = createSlackSdkLogger();
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

    expect(warnSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(9_999);
    expect(warnSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(warnSpy.mock.calls).toEqual([
      [
        '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=2 warnings=3 window_ms=10000',
      ],
    ]);
    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).not.toContain(HEARTBEAT_WARNING);
    for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
  });

  it('drops names, raw arguments, debug, and info while preserving safe warn/error severity', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createSlackSdkLogger();
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

    expect(logger.getLevel()).toBe(LogLevel.INFO);
    logger.setName(sentinels[0]);
    logger.setLevel(LogLevel.DEBUG);
    logger.debug(...args);
    logger.info(...args);
    logger.warn(...args);
    logger.error(...args);

    expect(logger.getLevel()).toBe(LogLevel.DEBUG);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls).toEqual([
      ['[slack.socket_mode] sdk_warning category=sdk_warning'],
      ['[slack.socket_mode] sdk_error category=unclassified lifecycle=starting'],
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
    const output = [warnSpy, errorSpy].flatMap((spy) => spy.mock.calls.flat()).join(' ');
    for (const sentinel of sentinels) expect(output).not.toContain(sentinel);

    logger.setLevel(LogLevel.ERROR);
    logger.warn(HEARTBEAT_WARNING, 'suppressed-sensitive-value');
    logger.error('another-sensitive-value');
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies safe categories and correlates active errors without retaining raw details', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = createSlackSdkLoggerController();

    controller.logger.error('WebSocket connection timeout token-sensitive');
    controller.setLifecycleState('active');
    controller.logger.error(new Error('rate limited by provider payload-sensitive'));
    controller.logger.error({ code: 'invalid_auth', token: 'xapp-sensitive' });

    expect(warnSpy).toHaveBeenCalledWith(
      '[slack.socket_mode] sdk_error category=transport lifecycle=starting'
    );
    expect(errorSpy.mock.calls).toEqual([
      ['[slack.socket_mode] sdk_error category=rate_limited lifecycle=active'],
      ['[slack.socket_mode] sdk_error category=authentication lifecycle=active'],
    ]);
    const output = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
    expect(output).not.toContain('sensitive');
    expect(output).not.toContain('invalid_auth');
  });

  it('caps retained state, uses one unref timer, and resets for the next window', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clients = Array.from({ length: 1_001 }, () => createSlackSdkLogger());

    for (const client of clients) client.warn(HEARTBEAT_WARNING);

    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    const timer = setTimeoutSpy.mock.results[0]?.value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef?.()).toBe(false);
    vi.advanceTimersByTime(10_000);

    expect(warnSpy).toHaveBeenNthCalledWith(
      1,
      '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=100+ warnings=1000+ window_ms=10000'
    );
    expect(vi.getTimerCount()).toBe(0);

    clients[0].warn(HEARTBEAT_WARNING);
    clients[0].warn(HEARTBEAT_WARNING);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);

    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=1 warnings=2 window_ms=10000'
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
