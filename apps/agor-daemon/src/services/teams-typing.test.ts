import { getCurrentTenantId, runWithTenantContext } from '@agor/core/db';
import type { GatewayChannel, TaskStatus } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamsNoticeOutcome } from './teams-notices.js';
import { TEAMS_TYPING_REFRESH_MS, TeamsTypingIndicators } from './teams-typing.js';

const channel = { id: 'channel-1', channel_type: 'teams', enabled: true } as GatewayChannel;
const target = {
  tenantId: 'tenant-a',
  sessionId: 'session-1',
  taskId: 'task-1',
  channelId: 'channel-1',
  threadId: '19:c|root-1',
};

function setup(options: { status?: TaskStatus | null; outcome?: TeamsNoticeOutcome } = {}) {
  let status: TaskStatus | null = options.status ?? 'running';
  let clock = 0;
  const tenants: Array<string | undefined> = [];
  const send = vi.fn(async (_channel: GatewayChannel, _threadId: string) => {
    tenants.push(getCurrentTenantId());
    return options.outcome ?? ('sent' as const);
  });
  const typing = new TeamsTypingIndicators({
    runInTenant: (tenantId, work) => runWithTenantContext(tenantId, work),
    taskStatus: async () => status,
    loadChannel: async () => channel,
    send,
    now: () => clock,
  });
  return {
    typing,
    send,
    tenants,
    setStatus: (next: TaskStatus | null) => {
      status = next;
    },
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TeamsTypingIndicators', () => {
  it('sends at once inside the tenant, refreshes while the Task runs, then stops', async () => {
    const { typing, send, tenants, setStatus } = setup();
    typing.start(target);
    typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(channel, target.threadId);
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS);
    expect(send).toHaveBeenCalledTimes(2);
    setStatus('completed');
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS * 3);
    expect(send).toHaveBeenCalledTimes(2);
    expect(typing.activeCount).toBe(0);
    expect(tenants).toEqual(['tenant-a', 'tenant-a']);
  });

  it('stops on request, on a failed or skipped send, and at the hard deadline', async () => {
    const stopped = setup();
    stopped.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    stopped.typing.stop('tenant-a', 'session-1');
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS * 3);
    expect(stopped.send).toHaveBeenCalledOnce();

    const failed = setup({ outcome: 'failed' });
    failed.typing.start(target);
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS * 3);
    expect(failed.send).toHaveBeenCalledOnce();
    expect(failed.typing.activeCount).toBe(0);

    const capped = setup();
    capped.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    capped.advanceClock(10 * 60_000);
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS * 3);
    expect(capped.send).toHaveBeenCalledOnce();
    expect(capped.typing.activeCount).toBe(0);
  });

  it('never restarts a Task whose indicator failed or expired, but resumes a paused one', async () => {
    const failed = setup({ outcome: 'skipped' });
    failed.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    failed.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(failed.send).toHaveBeenCalledOnce();
    failed.typing.start({ ...target, taskId: 'task-2' });
    await vi.advanceTimersByTimeAsync(0);
    expect(failed.send).toHaveBeenCalledTimes(2);

    const expired = setup();
    expired.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expired.advanceClock(10 * 60_000);
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS);
    expired.typing.start(target);
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS);
    expect(expired.send).toHaveBeenCalledOnce();

    const paused = setup({ status: 'awaiting_permission' });
    paused.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    paused.setStatus('running');
    paused.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(paused.send).toHaveBeenCalledOnce();
  });

  it('caps loops per tenant so one tenant cannot use up the indicator budget', async () => {
    const { typing } = setup();
    for (let index = 0; index < 70; index += 1) {
      typing.start({ ...target, sessionId: `a-${index}`, taskId: `a-task-${index}` });
    }
    typing.start({ ...target, tenantId: 'tenant-b' });
    expect(typing.activeCount).toBe(65);
  });

  it('never types for a queued Task and refuses new loops after shutdown', async () => {
    const queued = setup({ status: 'queued' });
    queued.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(queued.send).not.toHaveBeenCalled();

    const shutdown = setup();
    shutdown.typing.start(target);
    await vi.advanceTimersByTimeAsync(0);
    shutdown.typing.stopAll();
    shutdown.typing.start({ ...target, sessionId: 'session-2' });
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS * 3);
    expect(shutdown.send).toHaveBeenCalledOnce();
    expect(shutdown.typing.activeCount).toBe(0);
  });

  it('keeps one tenant from stopping another tenant’s loop for the same Session ID', async () => {
    const { typing, send, tenants } = setup();
    typing.start(target);
    typing.start({ ...target, tenantId: 'tenant-b' });
    await vi.advanceTimersByTimeAsync(0);
    typing.stop('tenant-b', target.sessionId);
    await vi.advanceTimersByTimeAsync(TEAMS_TYPING_REFRESH_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(tenants).toEqual(['tenant-a', 'tenant-b', 'tenant-a']);
  });
});
