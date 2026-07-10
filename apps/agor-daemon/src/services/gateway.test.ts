import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  attachHiddenTenant,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  shortId,
} from '@agor/core/db';
import { getConnector } from '@agor/core/gateway';
import type { GatewayChannel, SessionID, ThreadSessionMap, User, UserID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayService, tenantIdFromGatewayChannel } from './gateway.js';

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: vi.fn(),
  };
});

const user: User = {
  user_id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  role: 'admin',
  is_active: true,
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_login_at: null,
  avatar_url: null,
  default_agentic_config: {},
  unix_username: null,
} as unknown as User;

const slackChannel: GatewayChannel = {
  id: 'chan-slack',
  name: 'Slack Bot',
  channel_type: 'slack',
  channel_key: 'slack-key',
  enabled: true,
  target_branch_id: 'branch-1',
  agor_user_id: 'user-1',
  config: { bot_token: 'xoxb-test' },
  agentic_config: null,
  created_by: 'user-1',
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_message_at: null,
} as unknown as GatewayChannel;

function makeMapping(overrides: Partial<ThreadSessionMap> = {}): ThreadSessionMap {
  return {
    id: 'map-1',
    channel_id: slackChannel.id,
    thread_id: 'C123-100.000000',
    session_id: 'sess-1',
    branch_id: slackChannel.target_branch_id,
    status: 'active',
    metadata: {
      slack_last_delivered_ts: '101.000000',
      slack_active_thread_id: 'C123-100.000000',
    },
    created_at: '2026-06-22T00:00:00.000Z',
    last_message_at: '2026-06-22T00:00:00.000Z',
    ...overrides,
  } as unknown as ThreadSessionMap;
}

function makeGatewayHarness(args: {
  channel?: GatewayChannel;
  existingMapping?: ThreadSessionMap | null;
  connector?: Record<string, unknown>;
  db?: TenantScopeAwareDatabase;
}) {
  const channel = args.channel ?? slackChannel;
  let mapping = args.existingMapping ?? null;
  const promptCreate = vi.fn(async () => ({
    task_id: 'task-1',
    session_id: mapping?.session_id ?? 'sess-new',
    status: 'running',
  }));
  const sessionsCreate = vi.fn(async () => ({
    session_id: 'sess-new',
    branch_id: channel.target_branch_id,
    status: SessionStatus.IDLE,
  }));
  const app = {
    service: (name: string) => {
      if (name === 'users') return { get: vi.fn(async () => user) };
      if (name === 'sessions') {
        return { create: sessionsCreate, setMCPServers: vi.fn(async () => undefined) };
      }
      if (name === '/sessions/:id/prompt') return { create: promptCreate };
      throw new Error(`Unexpected service: ${name}`);
    },
  };
  const service = new GatewayService(args.db ?? ({} as TenantScopeAwareDatabase), app as never);
  const channelRepo = {
    findByKey: vi.fn(async () => channel),
    findById: vi.fn(async () => channel),
    updateLastMessage: vi.fn(async () => undefined),
  };
  const threadMapRepo = {
    findByChannelAndThread: vi.fn(async () => mapping),
    findByChannel: vi.fn(async () => []),
    findByThread: vi.fn(async () => null),
    findBySession: vi.fn(async () => mapping),
    updateLastMessage: vi.fn(async () => undefined),
    updateMetadata: vi.fn(async (_id: string, metadata: Record<string, unknown>) => {
      if (mapping) mapping = { ...mapping, metadata } as ThreadSessionMap;
    }),
    findById: vi.fn(async () => mapping),
    create: vi.fn(async (data: Partial<ThreadSessionMap>) => {
      mapping = makeMapping({
        ...data,
        id: 'map-new',
        session_id: data.session_id ?? 'sess-new',
        metadata: data.metadata ?? null,
      });
      return mapping;
    }),
  };
  (service as unknown as { channelRepo: typeof channelRepo }).channelRepo = channelRepo;
  (service as unknown as { threadMapRepo: typeof threadMapRepo }).threadMapRepo = threadMapRepo;
  (
    service as unknown as { outboundRepo: { findUnconsumedByChannelAndThread: unknown } }
  ).outboundRepo = {
    findUnconsumedByChannelAndThread: vi.fn(async () => null),
  };
  (
    service as unknown as { activeListeners: Map<string, Record<string, unknown>> }
  ).activeListeners.set(channel.id, args.connector ?? {});
  (service as unknown as { hasActiveChannels: boolean }).hasActiveChannels = true;

  return { service, promptCreate, sessionsCreate, channelRepo, threadMapRepo };
}

afterEach(() => {
  vi.mocked(getConnector).mockReset();
});

describe('gateway tenant metadata helpers', () => {
  it('extracts non-enumerable tenant metadata from gateway channel DTOs', () => {
    const channel = attachHiddenTenant({ ...slackChannel }, { tenant_id: 'tenant-channel' });

    expect(tenantIdFromGatewayChannel(channel)).toBe('tenant-channel');
    expect(Object.keys(channel)).not.toContain('tenant_id');
  });
});

describe('GatewayService Slack thread catch-up', () => {
  it('runs listener inbound callbacks inside a fresh channel tenant DB scope', async () => {
    const seenTenants: Array<string | undefined> = [];
    const app = {
      service: vi.fn(),
    };
    const service = new GatewayService({ run: vi.fn() } as never, app as never);
    vi.spyOn(service, 'create').mockImplementation(async () => {
      seenTenants.push(getCurrentTenantId() as string | undefined);
      return { success: true, sessionId: 'sess-1', created: false };
    });

    const channel = {
      ...slackChannel,
      tenant_id: 'tenant-channel',
    } as GatewayChannel & { tenant_id: string };

    await (
      service as unknown as {
        handleListenerInboundMessage(
          channel: GatewayChannel,
          tenantId: string | undefined,
          msg: {
            threadId: string;
            text: string;
            userId: string;
            metadata?: Record<string, unknown>;
          }
        ): Promise<void>;
      }
    ).handleListenerInboundMessage(channel, channel.tenant_id, {
      threadId: 'C123-100.000000',
      text: 'hello',
      userId: 'U123',
    });

    expect(seenTenants).toEqual(['tenant-channel']);
  });

  it('passes ambient tenant context into the internal prompt call', async () => {
    const mapping = makeMapping();
    const { service, promptCreate } = makeGatewayHarness({
      existingMapping: mapping,
      connector: {},
    });

    await runWithTenantDatabaseScope({ run: vi.fn() } as never, 'tenant-channel', () =>
      service.create({
        channel_key: 'slack-key',
        thread_id: 'C123-100.000000',
        text: 'please answer',
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '103.000000',
        },
      })
    );

    expect(promptCreate.mock.calls[0][1]).toMatchObject({
      route: { id: 'sess-1' },
      tenant: { tenant_id: 'tenant-channel', source: 'explicit' },
    });
  });

  it('fetches missed Slack messages after the last delivered cursor and advances the cursor', async () => {
    const sendMessage = vi.fn(async () => '104.000000');
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-100.000000',
      channel: 'C123',
      thread_ts: '100.000000',
      has_more: false,
      messages: [
        {
          ts: '101.000000',
          iso_time: '2026-06-22T00:00:01.000Z',
          actor_label: 'Alice',
          text: 'already seen',
          is_bot: false,
          is_trigger: false,
        },
        {
          ts: '102.000000',
          iso_time: '2026-06-22T00:00:02.000Z',
          actor_label: 'Bob',
          text: 'missed context',
          is_bot: false,
          is_trigger: false,
        },
        {
          ts: '103.000000',
          iso_time: '2026-06-22T00:00:03.000Z',
          actor_label: 'Alice',
          text: '<@U_BOT> please answer',
          is_bot: false,
          is_trigger: true,
        },
      ],
    }));
    const mapping = makeMapping({
      thread_id: 'C123-100.000000',
      metadata: {
        slack_last_delivered_ts: '101.000000',
        slack_active_thread_id: 'C123-200.000000',
      },
    });
    const { service, promptCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { fetchThreadHistory, sendMessage },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-200.000000',
      text: 'please answer',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '103.000000',
        slack_thread_ts: '100.000000',
        slack_user_name: 'Alice',
        slack_channel_name: 'eng',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1', created: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(fetchThreadHistory).toHaveBeenCalledWith({
      threadId: 'C123-100.000000',
      oldestTs: '101.000000',
      latestTs: '103.000000',
      inclusive: true,
      limit: 200,
      includeBotMessages: false,
      triggerTs: '103.000000',
    });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(
      'Any assistant message you send in this current Agor session is streamed back directly to the Slack conversation'
    );
    expect(prompt).toContain('**Slack context**');
    expect(prompt).toContain('### Previous thread messages');
    expect(prompt).toContain('missed context');
    expect(prompt).toContain('please answer');
    expect(prompt).toContain('2026-06-22 00:00:02 UTC');
    expect(prompt).not.toContain('already seen');
    expect(prompt).not.toContain('## Slack thread context');
    expect(threadMapRepo.updateMetadata).toHaveBeenLastCalledWith(
      'map-1',
      expect.objectContaining({
        slack_last_delivered_ts: '103.000000',
        slack_last_summon_ts: '103.000000',
      })
    );
  });

  it('does not advance the Slack delivered cursor when catch-up history fetch fails', async () => {
    const fetchThreadHistory = vi.fn(async () => {
      throw new Error('slack unavailable');
    });
    const mapping = makeMapping({
      thread_id: 'C123-100.000000',
      metadata: {
        slack_last_delivered_ts: '101.000000',
        slack_active_thread_id: 'C123-200.000000',
      },
    });
    const { service, promptCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { fetchThreadHistory },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-200.000000',
      text: 'please answer',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '103.000000',
        slack_thread_ts: '100.000000',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1', created: false });
    expect(promptCreate.mock.calls[0][0].prompt).toContain(
      'Any assistant message you send in this current Agor session is streamed back directly to the Slack conversation'
    );
    expect(promptCreate.mock.calls[0][0].prompt).toContain('please answer');
    expect(threadMapRepo.updateMetadata).not.toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({
        slack_last_delivered_ts: '103.000000',
      })
    );
    expect(warn).toHaveBeenCalledWith(
      '[gateway] Failed to fetch Slack thread catch-up context:',
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it('does not reserve a Slack thread globally across gateway channels', async () => {
    const sendMessage = vi.fn(async () => '100.000001');
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-100.000000',
      channel: 'C123',
      thread_ts: '100.000000',
      messages: [
        {
          ts: '100.000000',
          iso_time: '2026-06-22T00:00:00.000Z',
          actor_label: 'Alice',
          text: '<@U_BOT> start',
          is_bot: false,
          is_trigger: true,
        },
      ],
    }));
    const { service, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: null,
      connector: { fetchThreadHistory, sendMessage },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-100.000000',
      text: 'start',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '100.000000',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-new', created: true });
    expect(threadMapRepo.findByThread).not.toHaveBeenCalled();
    expect(sessionsCreate).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        text: expect.stringContaining('Mention me again to follow up.'),
        blocks: expect.any(Array),
      })
    );
    expect(threadMapRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: slackChannel.id,
        thread_id: 'C123-100.000000',
        session_id: 'sess-new',
      })
    );
  });

  it('rejects Slack channel-like messages that reach the gateway without an explicit mention', async () => {
    const fetchThreadHistory = vi.fn();
    const { service, promptCreate, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: makeMapping(),
      connector: { fetchThreadHistory },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-100.000000',
      text: 'this should not prompt',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: false,
        slack_message_ts: '104.000000',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(fetchThreadHistory).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(threadMapRepo.updateLastMessage).not.toHaveBeenCalled();
  });
});

describe('GatewayService Slack system message routing', () => {
  it('renders structured system messages with Slack context payloads', async () => {
    const sendMessage = vi.fn(async () => '104.000000');
    const mapping = makeMapping();
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { sendMessage },
    });

    const result = await service.routeMessage({
      session_id: 'sess-1',
      message: '[system] Session is ready',
      metadata: { system: { render_hint: 'context' } },
    });

    expect(result).toEqual({ routed: true, channelType: 'slack' });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        text: expect.stringContaining('Session is ready'),
        blocks: expect.any(Array),
      })
    );
  });
});

describe('GatewayService outbound routing tenant scope', () => {
  it('defers after-hook routing until the current tenant transaction commits', async () => {
    const events: string[] = [];
    const tx = {
      execute: vi.fn(async () => []),
    };
    let transactionCount = 0;
    let resolveRouted!: () => void;
    const routed = new Promise<void>((resolve) => {
      resolveRouted = resolve;
    });
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:commit');
        if (transactionCount === 3) resolveRouted();
        return result;
      }),
    } as TenantScopeAwareDatabase;

    const seenTenants: Array<string | undefined> = [];
    const sendMessage = vi.fn(async () => {
      events.push('send');
      seenTenants.push(getCurrentTenantId() as string | undefined);
      return '104.000000';
    });

    const { service } = makeGatewayHarness({
      db,
      existingMapping: makeMapping(),
      connector: { sendMessage },
    });

    await runWithTenantDatabaseScope(db, 'tenant-channel', async () => {
      service.routeMessageAfterCommit(
        {
          session_id: 'sess-1',
          message: 'hello from agent',
        },
        { tenant: { tenant_id: 'tenant-channel' } }
      );
      events.push('scheduled');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    await routed;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(seenTenants).toEqual(['tenant-channel']);
    expect(events).toEqual([
      'tx:start',
      'scheduled',
      'tx:commit',
      'tx:start',
      'tx:commit',
      'tx:start',
      'send',
      'tx:commit',
    ]);
  });
});

describe('GatewayService Slack progress tenant scope', () => {
  it('defers Slack assistant status updates until the current tenant transaction commits', async () => {
    const events: string[] = [];
    const tx = {
      execute: vi.fn(async () => []),
    };
    let transactionCount = 0;
    let resolveUpdated!: () => void;
    const updated = new Promise<void>((resolve) => {
      resolveUpdated = resolve;
    });
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:commit');
        if (transactionCount === 3) resolveUpdated();
        return result;
      }),
    } as TenantScopeAwareDatabase;

    const seenTenants: Array<string | undefined> = [];
    const setThreadStatus = vi.fn(async () => {
      events.push('status');
      seenTenants.push(getCurrentTenantId() as string | undefined);
    });

    const { service } = makeGatewayHarness({
      db,
      existingMapping: makeMapping(),
      connector: { setThreadStatus },
    });

    await runWithTenantDatabaseScope(db, 'tenant-channel', async () => {
      service.updateProgressAfterCommit(
        {
          session_id: 'sess-1',
          state: 'working',
          task_id: 'task-1',
          tool_name: 'Read',
        },
        { tenant: { tenant_id: 'tenant-channel' } }
      );
      events.push('scheduled');
      expect(setThreadStatus).not.toHaveBeenCalled();
    });

    await updated;

    expect(setThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        status: 'is using Read.',
      })
    );
    expect(seenTenants).toEqual(['tenant-channel']);
    expect(events).toEqual([
      'tx:start',
      'scheduled',
      'tx:commit',
      'tx:start',
      'tx:commit',
      'tx:start',
      'status',
      'tx:commit',
    ]);
  });
});

describe('GatewayService Slack streaming', () => {
  it('does not stream assistant chunks into channel-like Slack threads', async () => {
    const startStream = vi.fn(async () => '104.000000');
    const appendStream = vi.fn(async () => undefined);
    const mapping = makeMapping({
      metadata: {
        slack_active_thread_id: 'C123-100.000000',
        slack_user_id: 'U1',
        slack_team_id: 'T1',
      },
    });
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { startStream, appendStream },
    });

    await service.handleMessageStreamingEvent('streaming:start', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
    });
    await service.handleMessageStreamingEvent('streaming:chunk', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
      chunk: 'hello channel',
    });

    expect(startStream).not.toHaveBeenCalled();
    expect(appendStream).not.toHaveBeenCalled();
    expect(service.wasTaskStreamedToSlack?.('task-1')).toBe(false);
  });

  it('keeps streaming enabled for Slack DMs', async () => {
    const startStream = vi.fn(async () => '104.000000');
    const appendStream = vi.fn(async () => undefined);
    const mapping = makeMapping({
      thread_id: 'D123-100.000000',
      metadata: { slack_active_thread_id: 'D123-100.000000' },
    });
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { startStream, appendStream },
    });

    await service.handleMessageStreamingEvent('streaming:start', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
    });
    await service.handleMessageStreamingEvent('streaming:chunk', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
      chunk: 'hello dm',
    });

    expect(startStream).toHaveBeenCalledWith({
      threadId: 'D123-100.000000',
      text: 'hello dm',
      recipientUserId: undefined,
      recipientTeamId: undefined,
    });
    expect(service.wasTaskStreamedToSlack?.('task-1')).toBe(true);
  });
});

describe('GatewayService outbound emit session branch binding', () => {
  const outboundChannel: GatewayChannel = {
    ...slackChannel,
    id: 'chan-outbound',
    config: {
      bot_token: 'xoxb-test',
      outbound_enabled: true,
      default_outbound_target: 'channel:C123',
    },
  } as unknown as GatewayChannel;

  function makeEmitHarness(args: { session?: { session_id: string; branch_id: string } | null }) {
    const { service } = makeGatewayHarness({ channel: outboundChannel });
    const sendSlackMessage = vi.fn(async () => ({
      ts: '200.000100',
      channel: 'C123',
      thread_ts: '200.000100',
      permalink: null,
    }));
    vi.mocked(getConnector).mockReturnValue({ sendSlackMessage } as never);
    const outboundRepo = {
      create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'out-1', ...data })),
      findUnconsumedByChannelAndThread: vi.fn(async () => null),
    };
    const sessionRepo = { findById: vi.fn(async () => args.session ?? null) };
    const branchRepo = {
      findById: vi.fn(async () => ({
        branch_id: outboundChannel.target_branch_id,
        others_can: 'view',
      })),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'view'),
    };
    (service as unknown as { outboundRepo: unknown }).outboundRepo = outboundRepo;
    (service as unknown as { sessionRepo: unknown }).sessionRepo = sessionRepo;
    (service as unknown as { branchRepo: unknown }).branchRepo = branchRepo;
    return { service, sendSlackMessage, outboundRepo, sessionRepo, branchRepo };
  }

  type EmitData = Parameters<GatewayService['emitMessage']>[0];

  function emitData(overrides: Partial<EmitData> = {}): EmitData {
    return {
      gatewayChannelId: 'chan-outbound',
      message: 'ship update',
      emittedByUserId: 'user-1' as UserID,
      userRole: 'admin',
      ...overrides,
    };
  }

  it('allows a same-branch session emit and keeps session attribution on the audit row', async () => {
    const { service, sendSlackMessage, outboundRepo } = makeEmitHarness({
      session: { session_id: 'sess-1', branch_id: 'branch-1' },
    });

    const result = await service.emitMessage(
      emitData({ emittedBySessionId: 'sess-1' as SessionID })
    );

    expect(result).toMatchObject({
      success: true,
      gateway_outbound_message_id: 'out-1',
      gateway_channel_id: 'chan-outbound',
    });
    expect(sendSlackMessage).toHaveBeenCalledTimes(1);
    expect(outboundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ emitted_by_session_id: 'sess-1' })
    );
  });

  it('denies a cross-branch session emit even with admin role, before any Slack send', async () => {
    const { service, sendSlackMessage, outboundRepo, sessionRepo } = makeEmitHarness({
      session: { session_id: 'sess-1', branch_id: 'branch-2' },
    });

    await expect(
      service.emitMessage(emitData({ emittedBySessionId: 'sess-1' as SessionID }))
    ).rejects.toThrow(/Gateway outbound denied/);
    expect(sessionRepo.findById).toHaveBeenCalledWith('sess-1');
    expect(sendSlackMessage).not.toHaveBeenCalled();
    expect(outboundRepo.create).not.toHaveBeenCalled();
  });

  it('names the session branch but never the channel target branch in the denial', async () => {
    const { service } = makeEmitHarness({
      session: { session_id: 'sess-1', branch_id: 'branch-2' },
    });

    const error: Error = await service
      .emitMessage(emitData({ emittedBySessionId: 'sess-1' as SessionID }))
      .then(() => {
        throw new Error('expected emit to be denied');
      })
      .catch((err: Error) => err);

    expect(error.message).toContain(shortId('sess-1'));
    expect(error.message).toContain(shortId('branch-2'));
    expect(error.message).not.toContain(outboundChannel.target_branch_id);
    expect(error.message).not.toContain(shortId(outboundChannel.target_branch_id));
  });

  it('fails closed when the emitting session cannot be found', async () => {
    const { service, sendSlackMessage, outboundRepo } = makeEmitHarness({ session: null });

    await expect(
      service.emitMessage(emitData({ emittedBySessionId: 'sess-gone' as SessionID }))
    ).rejects.toThrow('Gateway outbound denied: emitting session not found');
    expect(sendSlackMessage).not.toHaveBeenCalled();
    expect(outboundRepo.create).not.toHaveBeenCalled();
  });

  it('keeps admin access for calls without session context', async () => {
    const { service, sendSlackMessage, sessionRepo } = makeEmitHarness({});

    const result = await service.emitMessage(emitData());

    expect(result).toMatchObject({ success: true });
    expect(sessionRepo.findById).not.toHaveBeenCalled();
    expect(sendSlackMessage).toHaveBeenCalledTimes(1);
  });

  it('denies no-session members without branch all permission', async () => {
    const { service, sendSlackMessage, branchRepo } = makeEmitHarness({});

    await expect(service.emitMessage(emitData({ userRole: 'member' }))).rejects.toThrow(
      'Insufficient branch permission'
    );
    expect(branchRepo.resolveUserPermission).toHaveBeenCalled();
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });
});
