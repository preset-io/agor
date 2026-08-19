import {
  ActivityType,
  GatewayOpcodes,
  type GatewaySendPayload,
  PresenceUpdateStatus,
} from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiscordAggregatePresence,
  DISCORD_PRESENCE_ACTIVE_COUNT_CAP,
  DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS,
  DiscordAggregatePresenceController,
} from './discord-presence';

function transport() {
  return {
    getShardIds: vi.fn(async () => [0, 2]),
    send: vi.fn(async (_shardId: number, _payload: GatewaySendPayload) => undefined),
  };
}

async function flushInitial(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Discord aggregate presence', () => {
  it('builds only the fixed idle/active payload and caps the count', () => {
    expect(buildDiscordAggregatePresence(0)).toEqual({
      since: null,
      afk: false,
      status: PresenceUpdateStatus.Idle,
      activities: [{ name: 'for @mentions', type: ActivityType.Watching }],
    });
    expect(buildDiscordAggregatePresence(1)).toMatchObject({
      status: PresenceUpdateStatus.Online,
      activities: [{ name: '1 active Agor session', type: ActivityType.Watching }],
    });
    expect(buildDiscordAggregatePresence(Number.POSITIVE_INFINITY).activities[0]?.name).toBe(
      'for @mentions'
    );
    expect(buildDiscordAggregatePresence(50_000).activities[0]?.name).toBe(
      `${DISCORD_PRESENCE_ACTIVE_COUNT_CAP} active Agor sessions`
    );
  });

  it('broadcasts opcode 3 to every shard and suppresses unchanged values', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    const ws = transport();
    const controller = new DiscordAggregatePresenceController(ws, {
      beforeSend: vi.fn(async () => true),
    });

    controller.request(1);
    await flushInitial();
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenNthCalledWith(1, 0, {
      op: GatewayOpcodes.PresenceUpdate,
      d: buildDiscordAggregatePresence(1),
    });
    expect(ws.send).toHaveBeenNthCalledWith(2, 2, {
      op: GatewayOpcodes.PresenceUpdate,
      d: buildDiscordAggregatePresence(1),
    });

    controller.request(1);
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS * 2);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('coalesces to the latest value and waits at least five seconds between broadcasts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    const ws = transport();
    const controller = new DiscordAggregatePresenceController(ws, {
      beforeSend: vi.fn(async () => true),
    });
    controller.request(1);
    await flushInitial();

    controller.request(2);
    controller.request(7);
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS - 1);
    expect(ws.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.send).toHaveBeenCalledTimes(4);
    expect(ws.send.mock.calls.at(-1)?.[1]).toEqual({
      op: GatewayOpcodes.PresenceUpdate,
      d: buildDiscordAggregatePresence(7),
    });
  });

  it('retries a failed broadcast conservatively and reconnect forces a resend', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    const ws = transport();
    ws.send.mockRejectedValueOnce(new Error('provider detail must not escape'));
    const diagnostics = vi.fn();
    const controller = new DiscordAggregatePresenceController(ws, {
      beforeSend: vi.fn(async () => true),
      onDiagnostic: diagnostics,
    });
    controller.request(3);
    await flushInitial();
    expect(controller.getDiagnostic()).toMatchObject({
      pending: true,
      retryCount: 1,
      lastErrorCode: 'discord_presence_send_failed',
    });
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS);
    expect(controller.getDiagnostic()).toMatchObject({ pending: false, retryCount: 0 });

    const callsAfterRecovery = ws.send.mock.calls.length;
    controller.resend();
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS);
    expect(ws.send.mock.calls.length).toBe(callsAfterRecovery + 2);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('provider detail');
  });

  it('bounds automatic retries after persistent send failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    const ws = transport();
    ws.getShardIds.mockResolvedValue([0]);
    ws.send.mockRejectedValue(new Error('provider detail must not escape'));
    const controller = new DiscordAggregatePresenceController(ws, {
      beforeSend: vi.fn(async () => true),
    });

    controller.request(5);
    await flushInitial();
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS * 10);
    expect(ws.send).toHaveBeenCalledTimes(4);
    expect(controller.getDiagnostic()).toMatchObject({
      pending: false,
      retryCount: 4,
      lastErrorCode: 'discord_presence_send_failed',
    });
  });

  it('cancels pending work on stop or owner loss without a stale send', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    const ws = transport();
    let current = true;
    const controller = new DiscordAggregatePresenceController(ws, {
      beforeSend: vi.fn(async () => current),
    });
    controller.request(1);
    await flushInitial();
    controller.request(2);
    current = false;
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS);
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(controller.getDiagnostic()).toMatchObject({
      pending: false,
      lastErrorCode: 'discord_presence_owner_lost',
    });

    const stoppedWs = transport();
    const stopped = new DiscordAggregatePresenceController(stoppedWs, {
      beforeSend: vi.fn(async () => true),
    });
    stopped.request(4);
    stopped.stop();
    await vi.runAllTimersAsync();
    expect(stoppedWs.send).not.toHaveBeenCalled();
  });
});
