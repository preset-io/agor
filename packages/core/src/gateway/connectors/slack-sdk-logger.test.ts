import { LogLevel } from '@slack/socket-mode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlackSdkLogger, SlackHeartbeatWarningAggregator } from './slack-sdk-logger';

const HEARTBEAT_WARNING = "A pong wasn't received from the server before the timeout of 5000ms!";

describe('Slack SDK logger', () => {
  const aggregators: SlackHeartbeatWarningAggregator[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const aggregator of aggregators.splice(0)) aggregator.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeAggregator(emitWarning: (message: string) => void, windowMs = 10_000) {
    const aggregator = new SlackHeartbeatWarningAggregator({ windowMs, emitWarning });
    aggregators.push(aggregator);
    return aggregator;
  }

  it('emits one safe summary for a synchronized heartbeat-timeout burst', () => {
    const emitWarning = vi.fn();
    const aggregator = makeAggregator(emitWarning);
    const firstClient = createSlackSdkLogger(aggregator);
    const secondClient = createSlackSdkLogger(aggregator);
    const sensitiveSentinels = [
      'tenant-sensitive',
      'channel-sensitive',
      'user-sensitive',
      'xapp-token-sensitive',
    ];

    firstClient.warn(HEARTBEAT_WARNING, ...sensitiveSentinels);
    firstClient.warn(HEARTBEAT_WARNING);
    secondClient.warn(HEARTBEAT_WARNING);

    expect(emitWarning).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);

    expect(emitWarning).toHaveBeenCalledOnce();
    expect(emitWarning).toHaveBeenCalledWith(
      '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=2 warnings=3 window_ms=10000'
    );
    const output = emitWarning.mock.calls.flat().join(' ');
    expect(output).not.toContain(HEARTBEAT_WARNING);
    for (const sentinel of sensitiveSentinels) expect(output).not.toContain(sentinel);
  });

  it('resets after each window and cancels pending work on cleanup', () => {
    const emitWarning = vi.fn();
    const aggregator = makeAggregator(emitWarning, 1_000);
    const client = createSlackSdkLogger(aggregator);

    client.warn(HEARTBEAT_WARNING);
    vi.advanceTimersByTime(1_000);
    client.warn(HEARTBEAT_WARNING);
    vi.advanceTimersByTime(1_000);

    expect(emitWarning).toHaveBeenCalledTimes(2);
    expect(emitWarning).toHaveBeenNthCalledWith(
      2,
      '[slack.socket_mode] heartbeat_timeout category=client_pong_timeout clients=1 warnings=1 window_ms=1000'
    );

    client.warn(HEARTBEAT_WARNING);
    aggregator.dispose();
    vi.advanceTimersByTime(1_000);
    expect(emitWarning).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves non-heartbeat warnings and errors at their original levels', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const aggregator = makeAggregator(vi.fn());
    const logger = createSlackSdkLogger(aggregator);
    logger.setName('socket-mode:SlackWebSocket:7');

    logger.warn('connection degraded');
    logger.error('connection failed');
    logger.error(new Error('xapp-sensitive-error'));

    expect(warnSpy).toHaveBeenCalledWith(
      '[WARN] ',
      'socket-mode:SlackWebSocket:7',
      'connection degraded'
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[ERROR] ',
      'socket-mode:SlackWebSocket:7',
      'connection failed'
    );
    expect(errorSpy).toHaveBeenLastCalledWith(
      '[ERROR] ',
      'socket-mode:SlackWebSocket:7',
      '[sdk_error]'
    );
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('xapp-sensitive-error');
    logger.setLevel(LogLevel.ERROR);
    logger.warn('suppressed by SDK log level');
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
