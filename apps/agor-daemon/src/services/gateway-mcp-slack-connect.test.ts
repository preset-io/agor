/**
 * The Slack connect card: what it says, and how it gets there.
 *
 * Mirrors `gateway-mcp-slack-recovery.test.ts` in shape — presentation first,
 * then durable delivery against an in-memory store faithful to the real CAS
 * contract. The states this lane has that the recovery lane does not
 * (`unavailable`, `connected_not_attached`) are the ones earlier review passes
 * asked to be visible rather than silent, so each is pinned here directly.
 */

import { runWithTenantContext } from '@agor/core/db';
import type {
  GatewayChannel,
  MCPServer,
  MCPServerID,
  MCPSlackConnectDelivery,
  Message,
  MessageID,
  Session,
  SessionID,
  Task,
  User,
  UserID,
  WidgetMessageMetadata,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

// A channel whose `provider_config_generation` moved is deliberately delivered
// through a freshly constructed connector rather than the process-local
// listener, whose token may predate the change. Constructing one needs real
// credentials, so the test supplies a stand-in and asserts which one was used.
const freshConnectorSend = vi.fn(async () => '1700000000.000002');
vi.mock('@agor/core/gateway', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/gateway');
  return {
    ...actual,
    getConnector: () => ({
      channelType: 'slack',
      sendMessage: freshConnectorSend,
      getAppInfo: async () => ({ teamId: 'T123' }),
    }),
  };
});

import { GatewayService } from './gateway.js';
import {
  MCP_SLACK_CONNECT_SHARED_WARNING_KEY,
  mcpSlackConnectBlocks,
  mcpSlackConnectCardCopy,
  mcpSlackConnectExpiryDelay,
  mcpSlackConnectMayReissue,
  mcpSlackConnectRenderedState,
  messageMayNeedMcpSlackConnectSync,
  slackConversationIsDirectMessage,
} from './mcp-slack-connect-card.js';

const WIDGET_ID = 'widget-1' as MessageID;
const SESSION_ID = 'session-1' as SessionID;
const SERVER_ID = 'server-1' as MCPServerID;
const OWNER = 'user-1' as UserID;
const THREAD = 'C123-1724688000.000100';
const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const EXPIRES_AT = '2026-09-16T12:10:00.000Z';

function widget(overrides: Partial<WidgetMessageMetadata> = {}): WidgetMessageMetadata {
  return {
    widget_type: 'oauth',
    widget_id: WIDGET_ID,
    schema_version: 1,
    status: 'pending',
    requested_at: '2026-09-16T11:59:00.000Z',
    params: {
      mcpServerId: SERVER_ID,
      serverName: 'Notion',
      oauthMode: 'per_user',
      reason: 'Read the roadmap page.',
    },
    ...overrides,
  } as WidgetMessageMetadata;
}

function delivery(overrides: Partial<MCPSlackConnectDelivery> = {}): MCPSlackConnectDelivery {
  return {
    delivery_id: 'delivery-1',
    delivery_generation: 1,
    token_jti: 'jti-1',
    issued_at: '2026-09-16T12:00:00.000Z',
    expires_at: EXPIRES_AT,
    gateway_config_generation: 7,
    ...overrides,
  };
}

describe('Slack MCP connect presentation', () => {
  it('projects every durable lifecycle state from the widget row and its link', () => {
    const state = (input: Parameters<typeof mcpSlackConnectRenderedState>[0], now = NOW) =>
      mcpSlackConnectRenderedState(input, now);

    expect(state({ widget: widget() })).toBe('connect_required');
    expect(state({ widget: widget(), delivery: delivery() })).toBe('connect_required');
    expect(
      state({ widget: widget(), delivery: delivery({ token_consumed_at: '2026-09-16T12:01:00Z' }) })
    ).toBe('sign_in_pending');
    expect(state({ widget: widget({ status: 'resolving' }) })).toBe('sign_in_pending');
    expect(
      state({
        widget: widget(),
        delivery: delivery({ oauth_succeeded_at: '2026-09-16T12:02:00Z' }),
      })
    ).toBe('sign_in_pending');
    expect(
      state({ widget: widget(), delivery: delivery({ oauth_failed_at: '2026-09-16T12:02:00Z' }) })
    ).toBe('expired');
    expect(state({ widget: widget(), delivery: delivery() }, Date.parse(EXPIRES_AT) + 1)).toBe(
      'expired'
    );
    expect(state({ widget: widget({ status: 'dismissed' }) })).toBe('cancelled');
    expect(
      state({ widget: widget({ status: 'submitted', result_meta: { attached: true } }) })
    ).toBe('connected');
    expect(
      state({ widget: widget({ status: 'already_present', result_meta: { attached: true } }) })
    ).toBe('connected');
  });

  it('is decided by the widget row, not by the link, once the widget resolves', () => {
    // The resolution is the daemon's own re-read of the persisted grant (D3).
    // A link record that still says "expired" or "failed" does not get to
    // contradict it.
    expect(
      mcpSlackConnectRenderedState(
        {
          widget: widget({ status: 'submitted', result_meta: { attached: true } }),
          delivery: delivery({ oauth_failed_at: '2026-09-16T12:02:00Z' }),
        },
        Date.parse(EXPIRES_AT) + 60_000
      )
    ).toBe('connected');
  });

  it('renders a lost alignment as a card state, never as silence', () => {
    // A tap would be refused at `/oauth-resolve`; the thread should learn that
    // from the card rather than from a button that 403s.
    expect(
      mcpSlackConnectRenderedState(
        { widget: widget(), delivery: delivery(), refusal: 'unaligned' },
        NOW
      )
    ).toBe('unavailable');
    expect(
      mcpSlackConnectRenderedState(
        { widget: widget(), delivery: delivery(), refusal: 'authority_moved' },
        NOW
      )
    ).toBe('unavailable');
    // Once recorded, the state no longer depends on a read that could flap.
    expect(
      mcpSlackConnectRenderedState(
        {
          widget: widget(),
          delivery: delivery({ binding_invalidated_at: '2026-09-16T12:03:00Z' }),
        },
        NOW
      )
    ).toBe('unavailable');
  });

  it('separates a connection that attached from one that did not', () => {
    expect(
      mcpSlackConnectRenderedState({
        widget: widget({ status: 'submitted', result_meta: { attached: false } }),
      })
    ).toBe('connected_not_attached');
    const copy = mcpSlackConnectCardCopy('connected_not_attached', {
      serverName: 'Notion',
      reason: 'r',
      oauthMode: 'per_user',
    });
    // `attached: false` means exactly one thing now, so the copy may name it.
    expect(copy.text).toMatch(/session owner or an Agor admin/i);
    expect(copy.text).toMatch(/connected/i);
    expect(copy.button).toBeUndefined();
  });

  it('offers a button in exactly one state', () => {
    for (const state of [
      'sign_in_pending',
      'connected',
      'connected_not_attached',
      'expired',
      'cancelled',
      'unavailable',
    ] as const) {
      const copy = mcpSlackConnectCardCopy(state, {
        serverName: 'Notion',
        reason: 'r',
        oauthMode: 'per_user',
      });
      expect(copy.button).toBeUndefined();
      expect(mcpSlackConnectBlocks(copy, 'https://agor.test/ui/connect/mcp#token=x')).toHaveLength(
        2
      );
    }
    const connect = mcpSlackConnectCardCopy('connect_required', {
      serverName: 'Notion',
      reason: 'Read the roadmap page.',
      oauthMode: 'per_user',
    });
    expect(connect.button).toBe('Connect Notion');
    const blocks = mcpSlackConnectBlocks(connect, 'https://agor.test/ui/connect/mcp#token=x');
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toMatchObject({
      type: 'actions',
      elements: [{ url: 'https://agor.test/ui/connect/mcp#token=x', type: 'button' }],
    });
    // A state that wants a button still renders without one when no link could
    // be minted, rather than emitting an actions block with no destination.
    expect(mcpSlackConnectBlocks(connect, undefined)).toHaveLength(2);
  });

  it('says out loud when a sign-in would be workspace-wide', () => {
    const shared = mcpSlackConnectCardCopy('connect_required', {
      serverName: 'Notion',
      reason: 'r',
      oauthMode: 'shared',
    });
    expect(shared.text).toMatch(/workspace-wide/i);
    const perUser = mcpSlackConnectCardCopy('connect_required', {
      serverName: 'Notion',
      reason: 'r',
      oauthMode: 'per_user',
    });
    expect(perUser.text).not.toMatch(/workspace-wide/i);
  });

  it('names the setting an admin has to change, and never claims a failure', () => {
    const unaligned = mcpSlackConnectCardCopy('unavailable', {
      serverName: 'Notion',
      reason: 'r',
      oauthMode: 'per_user',
      refusal: 'unaligned',
    });
    expect(unaligned.text).toMatch(/Align Slack users/i);
    const moved = mcpSlackConnectCardCopy('unavailable', {
      serverName: 'Notion',
      reason: 'r',
      oauthMode: 'per_user',
      refusal: 'authority_moved',
    });
    expect(moved.text).not.toMatch(/Align Slack users/i);
    // No card may imply a connection that did not happen, or leak a provider
    // error into a thread.
    for (const state of ['expired', 'cancelled', 'unavailable'] as const) {
      const copy = mcpSlackConnectCardCopy(state, {
        serverName: 'Notion',
        reason: 'r',
        oauthMode: 'per_user',
      });
      expect(copy.text).toMatch(/Nothing was connected/i);
      expect(copy.text).not.toMatch(/token|secret|error code/i);
    }
  });

  it('re-offers a failed sign-in once, and only inside the link it already has', () => {
    const failed = delivery({ oauth_failed_at: '2026-09-16T12:02:00Z' });
    expect(mcpSlackConnectMayReissue(widget(), failed, NOW)).toBe(true);
    // Past the link's own clock there is nothing to re-offer.
    expect(mcpSlackConnectMayReissue(widget(), failed, Date.parse(EXPIRES_AT) + 1)).toBe(false);
    // Nothing failed; a steady card must not churn its token every tick.
    expect(mcpSlackConnectMayReissue(widget(), delivery(), NOW)).toBe(false);
    // A resolved widget is never re-offered.
    expect(mcpSlackConnectMayReissue(widget({ status: 'submitted' }), failed, NOW)).toBe(false);
    // A re-issue clears the failure, which is what bounds the loop.
    expect(mcpSlackConnectMayReissue(widget(), delivery(), NOW)).toBe(false);
    expect(
      mcpSlackConnectRenderedState({ widget: widget(), delivery: failed, willReissue: true }, NOW)
    ).toBe('connect_required');
  });

  it('never holds an expiry timer open for a terminal card', () => {
    expect(mcpSlackConnectExpiryDelay('connect_required', delivery(), NOW)).toBe(601_000);
    expect(mcpSlackConnectExpiryDelay('sign_in_pending', delivery(), NOW)).toBe(601_000);
    expect(mcpSlackConnectExpiryDelay('connected', delivery(), NOW)).toBeUndefined();
    expect(mcpSlackConnectExpiryDelay('cancelled', delivery(), NOW)).toBeUndefined();
    expect(mcpSlackConnectExpiryDelay('unavailable', delivery(), NOW)).toBeUndefined();
    expect(
      mcpSlackConnectExpiryDelay('connect_required', delivery(), Date.parse(EXPIRES_AT))
    ).toBeUndefined();
    expect(mcpSlackConnectExpiryDelay('connect_required', undefined, NOW)).toBeUndefined();
  });

  it('wakes the projection only for a widget that actually has a card', () => {
    const message = (metadata: unknown) =>
      ({ message_id: WIDGET_ID, type: 'widget_request', metadata }) as unknown as Message;
    expect(messageMayNeedMcpSlackConnectSync(message({ widget: widget() }))).toBe(false);
    expect(
      messageMayNeedMcpSlackConnectSync(
        message({ widget: { ...widget(), slack_connect: delivery() } })
      )
    ).toBe(true);
    expect(
      messageMayNeedMcpSlackConnectSync(
        message({ widget: { ...widget({ widget_type: 'env_vars' }), slack_connect: delivery() } })
      )
    ).toBe(false);
    expect(
      messageMayNeedMcpSlackConnectSync({ message_id: WIDGET_ID, type: 'assistant', metadata: {} })
    ).toBe(false);
    expect(messageMayNeedMcpSlackConnectSync(null)).toBe(false);
  });

  it('treats an unrecognised conversation as shared rather than private', () => {
    expect(slackConversationIsDirectMessage('D123', 'im')).toBe(true);
    expect(slackConversationIsDirectMessage('C123', 'channel')).toBe(false);
    expect(slackConversationIsDirectMessage('C123', 'mpim')).toBe(false);
    // Pre-migration Tasks carry no conversation kind; the id prefix answers,
    // and anything that is not plainly a DM is warned about.
    expect(slackConversationIsDirectMessage('D999')).toBe(true);
    expect(slackConversationIsDirectMessage('C999')).toBe(false);
    expect(slackConversationIsDirectMessage('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Durable delivery
// ---------------------------------------------------------------------------

interface HarnessOptions {
  widget?: Partial<WidgetMessageMetadata>;
  delivery?: Partial<MCPSlackConnectDelivery> | null;
  channel?: Partial<GatewayChannel>;
  sendMessage?: ReturnType<typeof vi.fn>;
  /** `null` stands in for a connector that cannot delete its own messages. */
  deleteMessage?: ReturnType<typeof vi.fn> | null;
  claimMetadataFlag?: ReturnType<typeof vi.fn>;
  conversationType?: string;
  slackChannelId?: string;
  /** `'none'` stands in for a canvas (or non-Slack gateway) host task. */
  taskSource?: 'slack' | 'none';
}

function deliveryHarness(options: HarnessOptions = {}) {
  const initialDelivery =
    options.delivery === null
      ? undefined
      : delivery(options.delivery ?? { slack_message_ts: undefined });
  let message = {
    message_id: WIDGET_ID,
    session_id: SESSION_ID,
    task_id: 'task-1',
    type: 'widget_request',
    metadata: {
      widget: {
        ...widget(options.widget),
        ...(initialDelivery ? { slack_connect: initialDelivery } : {}),
      },
    },
  } as unknown as Message;

  const sendMessage = options.sendMessage ?? vi.fn(async () => '1700000000.000002');
  const findMessageByMetadata = vi.fn(async () => undefined);
  const deleteMessage =
    options.deleteMessage === null ? undefined : (options.deleteMessage ?? vi.fn(async () => {}));
  const connector = {
    channelType: 'slack' as const,
    findMessageByMetadata,
    sendMessage,
    ...(deleteMessage ? { deleteMessage } : {}),
  };
  const claimMetadataFlag = options.claimMetadataFlag ?? vi.fn(async () => true);

  const service = new GatewayService({ run: vi.fn() } as never, {} as never);
  Object.assign(service as unknown as Record<string, unknown>, {
    messagesRepo: {
      findById: async (id: MessageID) => (id === WIDGET_ID ? message : null),
      mutateMetadataLocked: async (
        id: MessageID,
        mutate: (metadata: Message['metadata'], value: Message) => Message['metadata'] | null
      ) => {
        if (id !== WIDGET_ID) throw new Error('not found');
        const next = mutate(message.metadata, message);
        if (next === null) return { changed: false, message };
        message = { ...message, metadata: next };
        return { changed: true, message };
      },
    },
    taskRepo: {
      findById: async () =>
        ({
          task_id: 'task-1',
          session_id: SESSION_ID,
          created_by: OWNER,
          metadata:
            options.taskSource === 'none'
              ? {}
              : {
                  gateway_task_source: {
                    gateway_channel_id: 'gateway-1',
                    channel_type: 'slack',
                    thread_id: THREAD,
                    provider_user_id: 'U123',
                    slack_team_id: 'T123',
                    slack_channel_id: options.slackChannelId ?? 'C123',
                    // Default to a DM so a test that counts sends is counting cards.
                    // The shared-thread notice has its own tests below.
                    slack_conversation_type: options.conversationType ?? 'im',
                  },
                },
        }) as unknown as Task,
    },
    sessionRepo: {
      findById: async () => ({ session_id: SESSION_ID, created_by: OWNER }) as Session,
    },
    usersRepo: { findById: async () => ({ user_id: OWNER, role: 'member' }) as User },
    channelRepo: {
      findById: async () =>
        ({
          id: 'gateway-1',
          enabled: true,
          channel_type: 'slack',
          provider_config_generation: 7,
          config: { align_slack_users: true, allowed_channel_ids: ['C123'] },
          ...options.channel,
        }) as GatewayChannel,
    },
    mcpServerRepo: {
      findById: async () =>
        ({
          mcp_server_id: SERVER_ID,
          enabled: true,
          config_version: 3,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        }) as MCPServer,
    },
    threadMapRepo: {
      findBySession: async () => ({ id: 'map-1', channel_id: 'gateway-1', thread_id: THREAD }),
      claimMetadataFlag,
    },
    activeListeners: new Map([['tenant-a\0gateway-1', connector]]),
  });

  return {
    service,
    sendMessage,
    deleteMessage,
    claimMetadataFlag,
    current: () => message.metadata?.widget?.slack_connect,
    widgetState: () => message.metadata?.widget?.status,
    dueMarker: () => message.metadata?.widget?.slack_connect_due_at,
    /** Stand in for a second daemon writing the same row mid-delivery. */
    patch: (
      mutate: (
        widget: WidgetMessageMetadata,
        delivery: MCPSlackConnectDelivery
      ) => Partial<WidgetMessageMetadata> & { slack_connect: MCPSlackConnectDelivery }
    ) => {
      const widget = message.metadata!.widget!;
      message = {
        ...message,
        metadata: {
          ...message.metadata,
          widget: { ...widget, ...mutate(widget, widget.slack_connect!) },
        },
      } as Message;
    },
    deliver: () =>
      runWithTenantContext('tenant-a', () =>
        (
          service as unknown as {
            deliverMcpSlackConnectCard(id: MessageID): Promise<void>;
          }
        ).deliverMcpSlackConnectCard(WIDGET_ID)
      ),
  };
}

describe('Slack MCP connect durable delivery', () => {
  const SECRET = 'connect-card-test-master-secret';
  const withSecret = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = process.env.AGOR_MASTER_SECRET;
    process.env.AGOR_MASTER_SECRET = SECRET;
    try {
      return await work();
    } finally {
      if (previous === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = previous;
    }
  };

  it('posts the first card, mints its link, and records what it rendered', async () => {
    const harness = deliveryHarness({ delivery: null });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    const request = harness.sendMessage.mock.calls[0]![0] as {
      threadId: string;
      blocks: { type: string; elements?: { url?: string }[] }[];
      metadata?: Record<string, unknown>;
    };
    expect(request.threadId).toBe(THREAD);
    const action = request.blocks.find((block) => block.type === 'actions');
    // The sealed token rides in the fragment and nowhere else.
    expect(action?.elements?.[0]?.url).toMatch(/#token=/);
    expect(action?.elements?.[0]?.url?.split('#')[0]).not.toContain('token');
    // First post carries its own reconciliation key; an edit would not.
    expect(request.metadata).toHaveProperty('slack_message_metadata');
    expect(harness.current()).toMatchObject({
      slack_message_ts: '1700000000.000002',
      rendered_state: 'connect_required',
      delivery_generation: 1,
      gateway_config_generation: 7,
    });
    expect(harness.current()?.delivery_claim).toBeUndefined();
    expect(harness.current()?.next_repair_at).toEqual(expect.any(String));
  });

  it('edits the same row rather than posting a second one', async () => {
    const harness = deliveryHarness({
      widget: { status: 'submitted', result_meta: { attached: true } },
      delivery: { slack_message_ts: '1700000000.000002', rendered_state: 'connect_required' },
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls[0]![0] as {
      metadata?: Record<string, unknown>;
      text: string;
    };
    expect(request.metadata).toMatchObject({ slack_update_ts: '1700000000.000002' });
    expect(request.metadata).not.toHaveProperty('slack_message_metadata');
    expect(request.text).toMatch(/connected/i);
    expect(harness.current()).toMatchObject({ rendered_state: 'connected' });
    // Terminal: nothing schedules another look at this card.
    expect(harness.current()?.next_repair_at).toBeUndefined();
  });

  it('retires a superseded widget in place', async () => {
    const harness = deliveryHarness({
      widget: { status: 'dismissed', resolved_at: '2026-09-16T12:05:00.000Z' },
      delivery: { slack_message_ts: '1700000000.000002', rendered_state: 'connect_required' },
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls[0]![0] as { blocks: { type: string }[] };
    expect(request.blocks.some((block) => block.type === 'actions')).toBe(false);
    expect(harness.current()).toMatchObject({ rendered_state: 'cancelled' });
  });

  it('turns a channel that stopped aligning Slack users into a visible refusal', async () => {
    const harness = deliveryHarness({
      channel: { config: { align_slack_users: false, allowed_channel_ids: ['C123'] } },
      delivery: { slack_message_ts: '1700000000.000002', rendered_state: 'connect_required' },
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls.at(-1)![0] as {
      text: string;
      blocks: { type: string }[];
    };
    expect(request.text).toMatch(/Align Slack users/i);
    expect(request.blocks.some((block) => block.type === 'actions')).toBe(false);
    expect(harness.current()).toMatchObject({ rendered_state: 'unavailable' });
    // Recorded durably, so a flapping read cannot make the button reappear.
    expect(harness.current()?.binding_invalidated_at).toEqual(expect.any(String));
  });

  it('does not post at all for a widget that never had a Slack card', async () => {
    const harness = deliveryHarness({
      delivery: null,
      channel: { config: { align_slack_users: false } },
    });
    await withSecret(() => harness.deliver());
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.current()).toBeUndefined();
  });

  /**
   * The mint-time marker is the widget's only durable trigger before a link
   * exists, so it is stamped from the session's origin — the Task's own
   * `gateway_task_source` is stripped from every `provider`-carrying read. The
   * projection is therefore the first thing that can tell a Slack widget from
   * one it will never post for, and it has to say so durably or the sweep
   * carries the row for a whole horizon.
   */
  it('retires the mint marker for a host task that is not a Slack thread', async () => {
    const harness = deliveryHarness({
      delivery: null,
      taskSource: 'none',
      widget: { slack_connect_due_at: '2026-09-16T11:59:00.000Z' },
    });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.dueMarker()).toBeUndefined();
    expect(harness.current()).toBeUndefined();
  });

  it('retires the mint marker for a widget that resolved before its first card', async () => {
    const harness = deliveryHarness({
      delivery: null,
      widget: {
        status: 'submitted',
        result_meta: { attached: true },
        slack_connect_due_at: '2026-09-16T11:59:00.000Z',
      },
    });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.dueMarker()).toBeUndefined();
  });

  it('keeps the mint marker for a refusal an administrator can undo', async () => {
    // Alignment can be switched back on, and the card the user was promised
    // has no other durable trigger. Dropping the marker here would make the
    // widget's Slack face unrecoverable.
    const harness = deliveryHarness({
      delivery: null,
      channel: { config: { align_slack_users: false } },
      widget: { slack_connect_due_at: '2026-09-16T11:59:00.000Z' },
    });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.dueMarker()).toBe('2026-09-16T11:59:00.000Z');
  });

  it('hands the due column to the delivery record once a link is issued', async () => {
    const harness = deliveryHarness({
      delivery: null,
      widget: { slack_connect_due_at: '2026-09-16T11:59:00.000Z' },
    });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.current()?.next_repair_at).toEqual(expect.any(String));
    // Left in place rather than cleared: `slack_connect` now decides the
    // indexed column outright, so the marker beneath it is inert either way
    // and one fewer write happens on the hot path.
    expect(harness.dueMarker()).toBe('2026-09-16T11:59:00.000Z');
  });

  it('renders once and then leaves a steady card alone', async () => {
    const harness = deliveryHarness({ delivery: null });
    await withSecret(() => harness.deliver());
    const firstGeneration = harness.current()?.delivery_generation;
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    // Crucially, a repeat projection does not churn the one-use token under a
    // user who is about to tap the button.
    expect(harness.current()?.delivery_generation).toBe(firstGeneration);
  });

  it('retries behind bounded backoff when Slack refuses the post', async () => {
    const harness = deliveryHarness({
      delivery: { slack_message_ts: '1700000000.000002', rendered_state: 'connect_required' },
      widget: { status: 'dismissed' },
      sendMessage: vi.fn(async () => Promise.reject(new Error('provider'))),
    });
    await withSecret(() => harness.deliver());

    expect(harness.current()).toMatchObject({
      delivery_attempt_count: 1,
      delivery_last_failed_at: expect.any(String),
      delivery_next_retry_at: expect.any(String),
      delivery_retry_until: expect.any(String),
      next_repair_at: expect.any(String),
    });
    expect(harness.current()?.delivery_claim).toBeUndefined();
    await harness.service.stopListeners();
  });

  it('refuses to deliver through a connector whose channel config moved', async () => {
    freshConnectorSend.mockClear();
    const harness = deliveryHarness({
      channel: { provider_config_generation: 9 },
      delivery: {
        slack_message_ts: '1700000000.000002',
        rendered_state: 'connect_required',
        gateway_config_generation: 7,
      },
    });
    await withSecret(() => harness.deliver());

    // The sealed token pins the generation redemption compares, so the card
    // stops offering a button that would be refused rather than showing one.
    expect(harness.current()?.binding_invalidated_at).toEqual(expect.any(String));
    expect(harness.current()?.rendered_state).toBe('unavailable');
    // Delivered through the freshly loaded connector, never the process-local
    // listener that may still hold the pre-mutation token.
    expect(harness.sendMessage).not.toHaveBeenCalled();
    const last = freshConnectorSend.mock.calls.at(-1)?.[0] as
      | { blocks: { type: string }[] }
      | undefined;
    expect(last?.blocks.some((block) => block.type === 'actions')).toBe(false);
  });

  it('warns a shared conversation once, and a DM never', async () => {
    const shared = deliveryHarness({ delivery: null, conversationType: 'channel' });
    await withSecret(() => shared.deliver());
    expect(shared.claimMetadataFlag).toHaveBeenCalledWith(
      'map-1',
      MCP_SLACK_CONNECT_SHARED_WARNING_KEY,
      expect.any(String)
    );
    expect(shared.sendMessage).toHaveBeenCalledTimes(2);
    expect((shared.sendMessage.mock.calls[0]![0] as { text: string }).text).toMatch(
      /shared conversation/i
    );

    const dm = deliveryHarness({
      delivery: null,
      conversationType: 'im',
      slackChannelId: 'C123',
    });
    await withSecret(() => dm.deliver());
    expect(dm.claimMetadataFlag).not.toHaveBeenCalled();
    expect(dm.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not repeat the shared-thread warning when the claim was already taken', async () => {
    const harness = deliveryHarness({
      delivery: null,
      conversationType: 'channel',
      claimMetadataFlag: vi.fn(async () => false),
    });
    await withSecret(() => harness.deliver());
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect((harness.sendMessage.mock.calls[0]![0] as { text: string }).text).not.toMatch(
      /shared conversation/i
    );
  });

  /**
   * A post that outlives its own 30s lease, landing after someone else won.
   *
   * The claim is a lease, so a stalled first post can return long after a
   * second claimant took the expired claim, posted the row that counts, and
   * released it. Treating an absent claim as consent then records the OTHER
   * card's `ts` and drops this one's receipt: two Slack messages for one
   * widget, and repair only ever edits the recorded one, so the stalled post's
   * live Connect button stays in the thread for good. Exactly the stale card
   * D7 accepted on the grounds that supersede handles it — which it cannot,
   * because this row is not in the record.
   */
  it('retires the card it posted after losing its delivery claim', async () => {
    let harness!: ReturnType<typeof deliveryHarness>;
    const sendMessage = vi.fn(async () => {
      if (sendMessage.mock.calls.length === 1) {
        // Meanwhile: the widget is dismissed, a second claimant takes the
        // expired claim, posts the terminal card, and records its own `ts`.
        harness.patch((widget, delivery) => ({
          status: 'dismissed',
          slack_connect: {
            ...delivery,
            delivery_claim: undefined,
            slack_message_ts: '1700000000.000009',
            rendered_state: 'cancelled',
          },
        }));
      }
      return '1700000000.000002';
    });
    harness = deliveryHarness({
      // A live link, so the card this delivery posts carries a real button —
      // which is the thing that must not be left in the thread.
      delivery: {
        slack_message_ts: undefined,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
      sendMessage,
    });
    await withSecret(() => harness.deliver());

    const posted = sendMessage.mock.calls[0]![0] as { blocks: { type: string }[] };
    expect(posted.blocks.some((block) => block.type === 'actions')).toBe(true);
    // The record still belongs to the claimant that won it.
    expect(harness.current()).toMatchObject({
      slack_message_ts: '1700000000.000009',
      rendered_state: 'cancelled',
    });
    // And the message this delivery posted is gone, rather than sitting in the
    // thread with a Connect button nothing will ever edit.
    expect(harness.deleteMessage).toHaveBeenCalledWith({
      threadId: THREAD,
      messageId: '1700000000.000002',
    });
  });

  it('edits a duplicate in place when the connector cannot delete', async () => {
    let harness!: ReturnType<typeof deliveryHarness>;
    const sendMessage = vi.fn(async () => {
      if (sendMessage.mock.calls.length === 1) {
        harness.patch((widget, delivery) => ({
          status: 'dismissed',
          slack_connect: {
            ...delivery,
            delivery_claim: undefined,
            slack_message_ts: '1700000000.000009',
            rendered_state: 'cancelled',
          },
        }));
      }
      return '1700000000.000002';
    });
    harness = deliveryHarness({
      delivery: {
        slack_message_ts: undefined,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
      sendMessage,
      // A connector that cannot delete still must not leave a live button.
      deleteMessage: null,
    });
    await withSecret(() => harness.deliver());

    const edit = sendMessage.mock.calls.at(-1)![0] as {
      metadata?: Record<string, unknown>;
      text: string;
      blocks: { type: string }[];
    };
    expect(edit.metadata).toMatchObject({ slack_update_ts: '1700000000.000002' });
    expect(edit.text).toMatch(/duplicate message/i);
    expect(edit.blocks.some((block) => block.type === 'actions')).toBe(false);
    expect(harness.current()).toMatchObject({ slack_message_ts: '1700000000.000009' });
  });

  it('posts nothing when the deployment seals no tokens', async () => {
    const harness = deliveryHarness({ delivery: null });
    const previous = process.env.AGOR_MASTER_SECRET;
    delete process.env.AGOR_MASTER_SECRET;
    try {
      await harness.deliver();
    } finally {
      if (previous !== undefined) process.env.AGOR_MASTER_SECRET = previous;
    }
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });
});
