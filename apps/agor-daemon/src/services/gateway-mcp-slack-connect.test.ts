/**
 * The Slack connect card: what it says, and how it gets there.
 *
 * Mirrors `gateway-mcp-slack-recovery.test.ts` in shape — presentation first,
 * then durable delivery against an in-memory store faithful to the real CAS
 * contract. The states this lane has that the recovery lane does not
 * (`unavailable`, `connected_not_attached`) are the ones earlier review passes
 * asked to be visible rather than silent, so each is pinned here directly.
 */

import { getBaseUrl } from '@agor/core/config';
import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  isMCPSlackConnectCardEnabled,
  MissingTenantDatabaseScopeError,
  runMigrations,
  runWithTenantContext,
} from '@agor/core/db';
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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mcpOAuthConnectClaimsMatchDelivery,
  verifyMCPOAuthConnectToken,
} from '../utils/mcp-oauth-connect-token.js';

// A channel whose `provider_config_generation` moved is deliberately delivered
// through a freshly constructed connector rather than the process-local
// listener, whose token may predate the change. Constructing one needs real
// credentials, so the test supplies a stand-in and asserts which one was used.
// The operator kill switch reads one app variable. Most projection tests care
// about what the switch DOES, not about the read, so the predicate is replaced
// by `killSwitch.stub` — EXCEPT in the scope-guard test at the bottom of this
// file, which clears the stub and drives the real read against a real
// scope-guarded database.
const killSwitch = vi.hoisted(() => ({ stub: null as null | (() => Promise<boolean>) }));
vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/db');
  const real = actual.isMCPSlackConnectCardEnabled as (db: unknown) => Promise<boolean>;
  return {
    ...actual,
    isMCPSlackConnectCardEnabled: (db: unknown) => (killSwitch.stub ?? (() => real(db)))(),
  };
});

// Whether the credential is on file. The card asks the one liveness function
// (D4); most delivery tests are about cards where it is not, so the default is
// the real read — which, against the harness's stand-in database handle,
// answers "no grant" the same way the production read would for a user who has
// not signed in.
const grantLiveness = vi.hoisted(() => ({
  live: false,
  refreshable: false,
  /** A read that fails rather than answering. See the swallowed-read test. */
  throws: null as null | Error,
}));
vi.mock('./mcp-oauth-grant-liveness.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./mcp-oauth-grant-liveness.js');
  return {
    ...actual,
    // The real `mcpOAuthGrantIsConnected` is kept (via `actual`) rather than
    // stubbed: the whole point of D4.1 is that the delivery loop asks the same
    // verdict every other surface asks, so a test that also stubbed the
    // verdict could not see it drift.
    resolveMCPOAuthGrantLiveness: async () => {
      if (grantLiveness.throws) throw grantLiveness.throws;
      return {
        live: grantLiveness.live,
        reason: grantLiveness.live ? 'live' : grantLiveness.refreshable ? 'expired' : 'no_grant',
        refreshable: grantLiveness.refreshable,
      };
    },
  };
});

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

import { hostedTenantRouting } from '../../test/hosted-tenant-routing-fixture.js';
import { WIDGET_RECLAIM_ABANDONED_AFTER_MS } from '../widgets/submissions.js';
import { GatewayService } from './gateway.js';
import {
  MCP_SLACK_CONNECT_MARKER_BACKOFF_MS,
  MCP_SLACK_CONNECT_MARKER_MAX_AGE_MS,
  MCP_SLACK_CONNECT_SHARED_WARNING_KEY,
  mcpSlackConnectBlocks,
  mcpSlackConnectCardCopy,
  mcpSlackConnectExpiryDelay,
  mcpSlackConnectMayReissue,
  mcpSlackConnectRefusedMarkerDueAt,
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

  it('offers a button in exactly two states', () => {
    for (const state of [
      'sign_in_pending',
      'connected',
      'connected_not_attached',
      'expired',
      'cancelled',
      'unavailable',
      'finish_stalled',
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

    // The second one, and the reason it is second: it asks for a finish, not a
    // sign-in, because the sign-in already happened.
    const finish = mcpSlackConnectCardCopy('finish_required', {
      serverName: 'Notion',
      reason: 'Read the roadmap page.',
      oauthMode: 'per_user',
    });
    expect(finish.button).toBe('Finish connecting Notion');
    expect(finish.text).toMatch(/signed in/i);
    expect(finish.text).not.toMatch(/sign in through Agor/i);
    expect(mcpSlackConnectBlocks(finish, 'https://agor.test/ui/connect/mcp#token=x')).toHaveLength(
      3
    );
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
    for (const state of ['cancelled', 'unavailable'] as const) {
      const copy = mcpSlackConnectCardCopy(state, {
        serverName: 'Notion',
        reason: 'r',
        oauthMode: 'per_user',
      });
      expect(copy.text).toMatch(/Nothing was connected/i);
      expect(copy.text).not.toMatch(/token|secret|error code/i);
    }
    // `expired` is the one that may NOT say it: a round-trip that reported
    // success and left no spendable grant lands here too, and that reader did
    // connect something. It says what is true of every branch instead.
    const expired = mcpSlackConnectCardCopy('expired', {
      serverName: 'Notion',
      reason: 'r',
      oauthMode: 'per_user',
    });
    expect(expired.text).not.toMatch(/Nothing was connected/i);
    expect(expired.text).toMatch(/no usable connection/i);
    expect(expired.text).not.toMatch(/token|secret|error code/i);
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

  it('reschedules a refused first-card marker without letting it live forever', () => {
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const fresh = mcpSlackConnectRefusedMarkerDueAt(
      {
        requested_at: '2026-09-16T11:59:00.000Z',
        slack_connect_due_at: '2026-09-16T11:59:00.000Z',
      },
      now
    );
    expect(fresh).toBe(new Date(now + MCP_SLACK_CONNECT_MARKER_BACKOFF_MS).toISOString());

    // Near the end of the window the next look is the deadline itself, never
    // past it.
    const nearly = '2026-09-15T12:02:00.000Z';
    expect(
      mcpSlackConnectRefusedMarkerDueAt({ requested_at: nearly, slack_connect_due_at: nearly }, now)
    ).toBe(new Date(Date.parse(nearly) + MCP_SLACK_CONNECT_MARKER_MAX_AGE_MS).toISOString());

    // Past it, the marker is pinned back to the anchor the sweep's horizon
    // already excludes — retired by ageing, exactly as before.
    const aged = '2026-09-15T11:00:00.000Z';
    expect(
      mcpSlackConnectRefusedMarkerDueAt({ requested_at: aged, slack_connect_due_at: aged }, now)
    ).toBe(aged);

    // Nothing to write.
    expect(mcpSlackConnectRefusedMarkerDueAt({ requested_at: aged }, now)).toBeUndefined();
    expect(
      mcpSlackConnectRefusedMarkerDueAt(
        { requested_at: 'not-a-date', slack_connect_due_at: 'not-a-date' },
        now
      )
    ).toBeUndefined();
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
  /**
   * Real, scope-guarded database handle for `this.db`.
   *
   * Every repository here is a stub, so nothing in this file trips the tenant
   * database scope guard by default — which is exactly why the guard has to be
   * handed in explicitly for the one read that is NOT a repository.
   */
  db?: unknown;
}

/**
 * A deployment with a public URL, which is now part of what a card needs.
 *
 * Without one `getBaseUrl` falls back to `http://localhost:{port}`, the lane
 * refuses the binding as `no_public_url`, and no card is posted — which is the
 * D2 behaviour two tests below pin directly. Every other test in this file is
 * about something else, so they are given the deployment a card is possible on.
 */
const PUBLIC_BASE_URL = 'https://agor.example.test';
beforeEach(() => {
  const previous = process.env.AGOR_BASE_URL;
  process.env.AGOR_BASE_URL = PUBLIC_BASE_URL;
  return () => {
    if (previous === undefined) delete process.env.AGOR_BASE_URL;
    else process.env.AGOR_BASE_URL = previous;
  };
});

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

  const service = new GatewayService((options.db ?? { run: vi.fn() }) as never, {} as never);
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
  beforeEach(() => {
    killSwitch.stub = async () => true;
    grantLiveness.live = false;
    grantLiveness.refreshable = false;
    grantLiveness.throws = null;
  });

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

  /**
   * Alignment can be switched back on, and the card the user was promised has
   * no other durable trigger — so the marker survives. Its QUEUE POSITION does
   * not: the sweep reads the oldest page of due work, so a marker left at its
   * original overdue timestamp sits at the front of that page for as long as
   * the refusal lasts, and fifty of them starve every healthy card behind
   * them of a first delivery and of every repair.
   */
  it('keeps a reversibly refused marker but moves it off the front of the queue', async () => {
    const requestedAt = new Date(Date.now() - 60_000).toISOString();
    const harness = deliveryHarness({
      delivery: null,
      channel: { config: { align_slack_users: false } },
      widget: { requested_at: requestedAt, slack_connect_due_at: requestedAt },
    });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).not.toHaveBeenCalled();
    const marker = harness.dueMarker();
    expect(marker).toBeDefined();
    expect(Date.parse(marker!)).toBeGreaterThan(Date.now());
    expect(Date.parse(marker!)).toBeLessThanOrEqual(
      Date.now() + MCP_SLACK_CONNECT_MARKER_BACKOFF_MS
    );
  });

  /**
   * Rescheduling must not make a marker immortal. The window stays anchored to
   * the mint, so a card nobody ever unblocks falls out of the sweep's horizon
   * exactly when it used to — by being pinned back to the anchor the horizon
   * already excludes.
   */
  it('stops rescheduling a marker that has aged past the repair horizon', async () => {
    const requestedAt = new Date(
      Date.now() - MCP_SLACK_CONNECT_MARKER_MAX_AGE_MS - 60_000
    ).toISOString();
    const harness = deliveryHarness({
      delivery: null,
      channel: { config: { align_slack_users: false } },
      widget: { requested_at: requestedAt, slack_connect_due_at: requestedAt },
    });
    await withSecret(() => harness.deliver());

    expect(harness.dueMarker()).toBe(requestedAt);
  });

  /**
   * D1's other branch: a widget with no delivery record has exactly one
   * durable trigger, and a throw must not leave it where it was.
   *
   * This is the 2026-09-16 shape exactly. The exception landed above every
   * write — there was no delivery record to account against even in principle
   * — so `slack_connect_due_at` kept its permanently-overdue mint timestamp
   * and the sweep re-selected the same widget every thirty seconds for the
   * full 24-hour horizon: 2880 attempts, no card, no accounting.
   *
   * Deliberately no attempt counter on the marker (§7.2): a refused visit
   * costs one read and makes no Slack call, which is exactly true of a throw
   * in the prologue, and a transient fault must not strand a card that would
   * have recovered.
   */
  it('moves the mint marker off the queue when the delivery throws before claiming', async () => {
    const requestedAt = new Date(Date.now() - 60_000).toISOString();
    // The kill-switch read is the very first line of delivery, above the
    // deps, the binding, the marker and the claim — where the incident's own
    // `MissingTenantDatabaseScopeError` landed.
    killSwitch.stub = async () => {
      throw new Error('read failed');
    };
    const harness = deliveryHarness({
      delivery: null,
      widget: { requested_at: requestedAt, slack_connect_due_at: requestedAt },
    });

    // Rethrown, so the sweep's per-pass tally still counts and classifies it.
    await expect(withSecret(() => harness.deliver())).rejects.toThrow();

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.current()).toBeUndefined();
    const marker = harness.dueMarker();
    expect(marker).not.toBe(requestedAt);
    expect(Date.parse(marker!)).toBeGreaterThan(Date.now());
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

  /**
   * Off disables the PROJECTION and nothing else. The canvas widget still
   * renders a live Connect button, and `agor_widgets_request_oauth` still
   * returns the `session_url` the agent relays — which is what makes this a
   * config change rather than a revert.
   */
  it('posts nothing at all when the card projection is switched off', async () => {
    killSwitch.stub = async () => false;
    const harness = deliveryHarness({ delivery: null });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).not.toHaveBeenCalled();
    // No link was minted either: a switched-off lane must not leave a sealed
    // token behind that redemption would then have to refuse.
    expect(harness.current()).toBeUndefined();
  });

  it('stops repainting a card that is already in the thread', async () => {
    killSwitch.stub = async () => false;
    const harness = deliveryHarness({
      widget: { status: 'submitted', result_meta: { attached: true } },
      delivery: { slack_message_ts: '1700000000.000002', rendered_state: 'connect_required' },
    });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.current()?.rendered_state).toBe('connect_required');
  });

  /**
   * The bounded repair sweep runs under `runWithTenantContext` and nothing
   * else: it holds tenant CONTEXT, not a tenant database SCOPE. Every
   * repository in this service opens its own through
   * `bindRepositoryToTenantUnitOfWork`, but the two app-variable settings both
   * MCP Slack lanes read on their first line are free functions with nothing
   * to open one — so against the production guard they threw
   * `MissingTenantDatabaseScopeError` straight into the sweep's
   * `.catch(() => undefined)`, and the sweep repaired nothing, silently.
   *
   * Every other test in this file stubs the repositories, which is exactly why
   * none of them could see it. This one hands the service a real guarded
   * handle and clears the kill-switch stub, so the read that broke is the read
   * under test.
   */
  it('reads its settings inside a scope, on a caller that holds only tenant context', async () => {
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    await runMigrations(rawDb);
    const guarded = createTenantScopedDatabaseProxy(rawDb, {
      requireScope: true,
      label: 'connect card scope guard',
    });
    killSwitch.stub = null;
    // The bare read is what used to run here. Pinned so this test fails if the
    // guard is ever relaxed, rather than only if the fix is reverted.
    await expect(isMCPSlackConnectCardEnabled(guarded as never)).rejects.toThrow(
      /tenant database scope/i
    );

    const harness = deliveryHarness({ delivery: null, db: guarded });
    await withSecret(() => harness.deliver());

    expect(harness.sendMessage).toHaveBeenCalled();
    expect(harness.current()?.rendered_state).toBe('connect_required');
    await harness.service.stopListeners();
  });

  /**
   * Hosted mode: the button URL comes from the tenant's own routing, and a
   * tenant that has none gets no card at all.
   *
   * The seventh instance of the tenant-scope class on this branch, and the
   * first one the delivery lane could not survive: `mcpSlackConnectDeps` made
   * a BARE `getBaseUrl()` call, which under `required_from_auth` needs a
   * handle or an ambient database scope and had neither. It threw on the first
   * line of delivery — above the refusal classifier, above the marker
   * retirement, above the claim — so the lane reported `unexpected`, classified
   * nothing, posted nothing, and retried on an unbounded thirty-second clock.
   * Every test above this one runs single-tenant, where the hosted branch is
   * never taken and the missing argument is inert.
   *
   * The second half is the guard the recovery lane has always had and this
   * lane did not. A handle is not routing: a tenant whose verified launch has
   * not landed answers `''`, `getMcpOAuthConnectUrl('')` answers `''` too, and
   * the button URL degrades to a bare `#token=<jwt>`. Slack rejects those
   * blocks — and because the one-use token is minted before the post, each of
   * the six attempts burned a fresh link before the card stranded.
   */
  it('builds the card link from tenant routing, holding only tenant context', async () => {
    const hosted = await hostedTenantRouting({
      tenantId: 'tenant-a',
      origin: 'https://tenant-a.example.test',
    });
    try {
      // The shape that shipped. Pinned by cast because `getBaseUrl` no longer
      // lets a caller express it — which is the point of the required handle.
      await expect(
        runWithTenantContext('tenant-a', () => (getBaseUrl as unknown as () => Promise<string>)())
      ).rejects.toThrow(/tenant database/i);

      killSwitch.stub = null;
      const harness = deliveryHarness({ delivery: null, db: hosted.db });
      await withSecret(() => harness.deliver());

      const request = harness.sendMessage.mock.calls[0]![0] as {
        blocks: { type: string; elements?: { url?: string }[] }[];
      };
      const url = request.blocks.find((block) => block.type === 'actions')?.elements?.[0]?.url;
      expect(url).toMatch(/#token=/);
      expect(new URL(url as string).origin).toBe('https://tenant-a.example.test');
      // `AGOR_BASE_URL` is the deployment cell, shared by every tenant. A
      // hosted link must never fall back to it.
      expect(url).not.toContain(new URL(hosted.cellBaseUrl).host);
      expect(harness.current()).toMatchObject({ rendered_state: 'connect_required' });
      await harness.service.stopListeners();
    } finally {
      await hosted.cleanup();
    }
  });

  /**
   * D2: an unbuildable link is a classified REFUSAL, not a throw.
   *
   * The template was one line away the whole time — `masterSecret` has always
   * tolerated an absent secret and let `resolveSlackConnectBinding` classify it
   * as `no_secret`. A throw here lands above the refusal classifier, above the
   * marker reschedule and above the claim, which is the D1 shape: nothing
   * accounted, nothing rescheduled, and the sweep coming back every thirty
   * seconds for a day.
   *
   * Two conditions, one refusal, because the card cannot tell them apart and
   * an administrator fixes both the same way. An uninitialised hosted tenant
   * answers `''`; a deployment that never configured a public URL answers
   * `http://localhost:{port}`, which reads as a perfectly good URL and posts a
   * card whose button works for nobody.
   */
  it.each([
    [
      'a hosted tenant whose public routing is not initialized',
      async () => {
        const hosted = await hostedTenantRouting({ tenantId: 'tenant-a' });
        return { db: hosted.db, cleanup: hosted.cleanup };
      },
    ],
    [
      'a deployment with only the localhost fallback',
      async () => {
        const previous = process.env.AGOR_BASE_URL;
        delete process.env.AGOR_BASE_URL;
        return {
          db: undefined,
          cleanup: async () => {
            if (previous !== undefined) process.env.AGOR_BASE_URL = previous;
          },
        };
      },
    ],
  ])('refuses to post a card for %s', async (_label, setup) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, cleanup } = await setup();
    try {
      const requestedAt = new Date(Date.now() - 60_000).toISOString();
      const harness = deliveryHarness({
        delivery: null,
        widget: { requested_at: requestedAt, slack_connect_due_at: requestedAt },
        ...(db ? { db } : {}),
      });

      // A refusal, not an exception.
      await withSecret(() => harness.deliver());

      // Nothing posted, and — crucially — no one-use token minted and burned.
      expect(harness.sendMessage).not.toHaveBeenCalled();
      expect(harness.current()).toBeUndefined();
      // Reversible: the marker keeps the trigger and gives up its queue
      // position, so an administrator fixing the configuration gets the card
      // within one backoff.
      const marker = harness.dueMarker();
      expect(Date.parse(marker!)).toBeGreaterThan(Date.now());
      // And it is no longer silent. A first-card refusal used to return with
      // nothing written and nothing logged.
      expect(
        warn.mock.calls.some(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('stage=binding') &&
            call[0].includes('reason=no_public_url')
        )
      ).toBe(true);
      await harness.service.stopListeners();
    } finally {
      warn.mockRestore();
      await cleanup();
    }
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

  /**
   * After six failures inside fifteen minutes the card is permanently
   * stranded: nothing reschedules it, and the thread keeps whatever it last
   * rendered. That outcome has to be distinguishable in the log from an
   * ordinary retry, or an operator finds out from the user.
   */
  it('reports a stranded card at error level, with the ids needed to find it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const retrying = deliveryHarness({
        delivery: { slack_message_ts: '1700000000.000002', rendered_state: 'connect_required' },
        widget: { status: 'dismissed' },
        sendMessage: vi.fn(async () => Promise.reject(new Error('channel_not_found'))),
      });
      await withSecret(() => retrying.deliver());
      expect(error).not.toHaveBeenCalled();
      expect(warn.mock.calls.at(-1)?.[0]).toContain('retrying=true');
      expect(warn.mock.calls.at(-1)?.[0]).toContain('stranded=false');
      await retrying.service.stopListeners();

      const stranded = deliveryHarness({
        delivery: {
          slack_message_ts: '1700000000.000002',
          rendered_state: 'connect_required',
          delivery_attempt_count: 5,
          delivery_retry_until: new Date(Date.now() + 60_000).toISOString(),
        },
        widget: { status: 'dismissed' },
        sendMessage: vi.fn(async () => Promise.reject(new Error('channel_not_found'))),
      });
      await withSecret(() => stranded.deliver());

      const line = error.mock.calls.at(-1)?.[0] as string;
      expect(line).toContain('event=mcp_slack_connect_delivery_failed');
      expect(line).toContain(`widget_id=${WIDGET_ID}`);
      expect(line).toContain('tenant_id=tenant-a');
      expect(line).toContain('reason=slack_write_failed');
      expect(line).toContain('attempt=6/6');
      expect(line).toContain('stranded=true');
      // The exception is never in it: `context/guidelines/logging.md` forbids
      // provider errors and messages, and the reason field is Agor's own.
      expect(line).not.toMatch(/channel_not_found|Error|C123|1700000000/);
      await stranded.service.stopListeners();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  /**
   * The other half of the same rule, on the read this lane swallows on
   * purpose.
   *
   * A grant-liveness read that THROWS must still render the card as
   * not-connected — offering a finish the resolver would refuse is the defect
   * D4.1 closed — but the delivery then succeeds, so the sweep's per-item
   * `.catch` never sees it. That silence is how four of six tenant-scope
   * defects reached a running daemon: the symptom was "the card says you are
   * not connected", which is also what a genuine absence looks like.
   */
  it('reports a grant-liveness read it swallowed, and still fails closed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      grantLiveness.live = true; // Connected — if the read had worked.
      grantLiveness.throws = new MissingTenantDatabaseScopeError('card read of the grant');
      const harness = deliveryHarness({ delivery: null });
      await withSecret(() => harness.deliver());

      // Fail closed: the verdict is still "no credential on file".
      expect(harness.current()?.rendered_state).toBe('connect_required');

      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes('event=mcp_slack_repair_failed'));
      expect(line).toBeDefined();
      expect(line).toContain('lane=connect');
      // The stage is what separates this from a repair pass that threw: the
      // delivery succeeded, and this one read did not.
      expect(line).toContain('stage=grant_liveness');
      expect(line).toContain('reason=missing_tenant_scope');
      expect(line).toContain(`first_entity_id=${WIDGET_ID}`);
      expect(line).toContain('tenant_id=tenant-a');
      // Nothing the exception or the provider said.
      expect(line).not.toMatch(/card read of the grant|Error|C123|1700000000/);
      await harness.service.stopListeners();
    } finally {
      warn.mockRestore();
    }
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

  /**
   * The other half of a lost claim: an EDIT that lands last.
   *
   * A re-issue edits the one recorded row rather than posting a new one, so
   * nothing is orphaned — but if the claim lapsed while Slack was being
   * called, the edit repaints the card that counts with a state a second
   * claimant has already superseded. The record says `cancelled`; the thread
   * shows a Connect button. Every later render compares against
   * `rendered_state`, so the disagreement seals itself in: the no-op
   * shortcut, the claim CAS and an explicit repair all skip a card whose
   * recorded state already matches the state that would render now.
   */
  it('repaints the card it edited after losing its delivery claim', async () => {
    let harness!: ReturnType<typeof deliveryHarness>;
    const sendMessage = vi.fn(async () => {
      if (sendMessage.mock.calls.length === 1) {
        // Meanwhile: the lease lapses, the widget is dismissed, and a second
        // claimant renders the terminal card onto the same row and clears the
        // repair deadline behind it.
        harness.patch((_widget, delivery) => ({
          status: 'dismissed',
          resolved_at: '2026-09-16T12:05:00.000Z',
          slack_connect: {
            ...delivery,
            delivery_claim: undefined,
            rendered_state: 'cancelled',
            rendered_at: '2026-09-16T12:05:00.000Z',
            next_repair_at: undefined,
          },
        }));
      }
      return '1700000000.000002';
    });
    harness = deliveryHarness({
      // A durably failed sign-in that may be re-offered once: the render this
      // delivery is about to perform carries a fresh button.
      delivery: {
        slack_message_ts: '1700000000.000002',
        rendered_state: 'expired',
        oauth_failed_at: '2026-09-16T12:02:00.000Z',
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
      sendMessage,
    });
    await withSecret(() => harness.deliver());

    // The delayed edit really did put a Connect button back in the thread.
    const late = sendMessage.mock.calls[0]![0] as {
      metadata?: Record<string, unknown>;
      blocks: { type: string }[];
    };
    expect(late.metadata).toMatchObject({ slack_update_ts: '1700000000.000002' });
    expect(late.blocks.some((block) => block.type === 'actions')).toBe(true);

    // End state: the thread agrees with the row again. Nothing was orphaned,
    // so nothing is deleted — the card is repainted in place.
    const last = sendMessage.mock.calls.at(-1)![0] as {
      metadata?: Record<string, unknown>;
      text: string;
      blocks: { type: string }[];
    };
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(last.metadata).toMatchObject({ slack_update_ts: '1700000000.000002' });
    expect(last.blocks.some((block) => block.type === 'actions')).toBe(false);
    expect(last.text).toMatch(/Nothing was connected/i);
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.current()).toMatchObject({
      slack_message_ts: '1700000000.000002',
      rendered_state: 'cancelled',
    });
  });

  it('leaves the record alone when the winner rendered the same state', async () => {
    let harness!: ReturnType<typeof deliveryHarness>;
    const sendMessage = vi.fn(async () => {
      if (sendMessage.mock.calls.length === 1) {
        harness.patch((_widget, delivery) => ({
          slack_connect: {
            ...delivery,
            delivery_claim: undefined,
            rendered_state: 'connected',
            rendered_at: '2026-09-16T12:05:00.000Z',
          },
        }));
      }
      return '1700000000.000002';
    });
    harness = deliveryHarness({
      widget: { status: 'submitted', result_meta: { attached: true } },
      delivery: { slack_message_ts: '1700000000.000002', rendered_state: 'connect_required' },
      sendMessage,
    });
    await withSecret(() => harness.deliver());

    // Two daemons painted the same terminal card. There is nothing to undo,
    // and a repaint here would be a second edit for no reason.
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(harness.current()).toMatchObject({
      rendered_state: 'connected',
      rendered_at: '2026-09-16T12:05:00.000Z',
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

/**
 * B1 — the card for a sign-in that succeeded and was never finished.
 *
 * The provider callback persists the grant; the attach and the agent's wake-up
 * wait on a browser POST. A thread whose user closed that page used to show
 * "Sign-in is in progress… this message updates when it lands" forever, with
 * no button, which is both false and unrecoverable from Slack.
 */
describe('Slack MCP connect — finishing an abandoned sign-in', () => {
  const abandonedClaim = (ageMs: number) => ({
    token: 'claim-1',
    action: 'oauth_callback' as const,
    claimed_at: new Date(NOW - ageMs).toISOString(),
    claimed_by: OWNER,
  });

  it('offers a finish once the grant is on file, whatever the link record says', () => {
    const succeeded = delivery({
      token_consumed_at: '2026-09-16T12:01:00Z',
      oauth_succeeded_at: '2026-09-16T12:02:00Z',
    });
    expect(
      mcpSlackConnectRenderedState(
        { widget: widget(), delivery: succeeded, grantConnected: true },
        NOW
      )
    ).toBe('finish_required');
    // Without the grant the same record is still a round-trip in flight: the
    // card follows the credential, not the browser's report of one.
    expect(
      mcpSlackConnectRenderedState(
        { widget: widget(), delivery: succeeded, grantConnected: false },
        NOW
      )
    ).toBe('sign_in_pending');
  });

  it('checks the link clock before the round-trip outcome, not after', () => {
    // The ordering bug this fixes: `oauth_succeeded_at` used to be read first,
    // so a lapsed link with a finished round-trip rendered as a sign-in still
    // in progress — the one state with neither a button nor an end.
    const succeeded = delivery({ oauth_succeeded_at: '2026-09-16T12:02:00Z' });
    const afterExpiry = Date.parse(EXPIRES_AT) + 1;
    expect(
      mcpSlackConnectRenderedState({ widget: widget(), delivery: succeeded }, afterExpiry)
    ).toBe('expired');
    // …and with the grant actually on file it is a finish that lost its link,
    // whose answer is to ask again at no cost, not to sign in again.
    expect(
      mcpSlackConnectRenderedState(
        { widget: widget(), delivery: succeeded, grantConnected: true },
        afterExpiry
      )
    ).toBe('finish_stalled');
    const copy = mcpSlackConnectCardCopy('finish_stalled', {
      serverName: 'Notion',
      reason: 'r',
      oauthMode: 'per_user',
    });
    expect(copy.button).toBeUndefined();
    expect(copy.text).toMatch(/will not have to sign in again/i);
  });

  it('waits for a live resolution claim, then offers the finish once it is abandoned', () => {
    const live = widget({ status: 'resolving', resolution_claim: abandonedClaim(5_000) });
    expect(
      mcpSlackConnectRenderedState(
        { widget: live, delivery: delivery(), grantConnected: true },
        NOW
      )
    ).toBe('sign_in_pending');
    // Past the point where `submissions.ts` will take the claim over, the
    // button does something again — the two rules are the same constant.
    const abandoned = widget({
      status: 'resolving',
      resolution_claim: abandonedClaim(WIDGET_RECLAIM_ABANDONED_AFTER_MS + 1_000),
    });
    expect(
      mcpSlackConnectRenderedState(
        { widget: abandoned, delivery: delivery(), grantConnected: true },
        NOW
      )
    ).toBe('finish_required');
  });

  it('never offers a finish on an abandoned claim the resolver would refuse', () => {
    // "Not now" claimed the widget for `dismiss`, the resolver died, and a
    // minute passed. The claim is abandoned by the clock, so an age-only test
    // called this `finish_required` — and the button submits `oauth_callback`,
    // which `submissions.ts` refuses because the claim belongs to `dismiss`
    // (see its mirror case in `widgets/submissions.test.ts`). The card must
    // not offer what the resolver would refuse, so it stays the honest
    // buttonless pending state until something resolves the claim.
    const dismissClaim = widget({
      status: 'resolving',
      resolution_claim: {
        ...abandonedClaim(WIDGET_RECLAIM_ABANDONED_AFTER_MS + 60_000),
        action: 'dismiss' as const,
      },
    });
    const state = mcpSlackConnectRenderedState(
      { widget: dismissClaim, delivery: delivery(), grantConnected: true },
      NOW
    );
    expect(state).toBe('sign_in_pending');
    expect(
      mcpSlackConnectCardCopy(state, { serverName: 'Notion', reason: 'r', oauthMode: 'per_user' })
        .button
    ).toBeUndefined();
    // A `submit` claim is refused by the same rule — this lane is
    // `daemon_verified`, so nothing but `oauth_callback` can ever finish it.
    expect(
      mcpSlackConnectRenderedState(
        {
          widget: widget({
            status: 'resolving',
            resolution_claim: {
              ...abandonedClaim(WIDGET_RECLAIM_ABANDONED_AFTER_MS + 60_000),
              action: 'submit' as const,
            },
          }),
          delivery: delivery(),
          grantConnected: true,
        },
        NOW
      )
    ).toBe('sign_in_pending');
  });

  it('never offers a finish for a resolved, dismissed or retired card', () => {
    for (const widgetRow of [
      widget({ status: 'submitted', result_meta: { attached: true } }),
      widget({ status: 'dismissed' }),
    ]) {
      expect(
        mcpSlackConnectRenderedState(
          { widget: widgetRow, delivery: delivery(), grantConnected: true },
          NOW
        )
      ).not.toMatch(/^finish/);
    }
    expect(
      mcpSlackConnectRenderedState(
        {
          widget: widget(),
          delivery: delivery({ binding_invalidated_at: '2026-09-16T12:03:00Z' }),
          grantConnected: true,
        },
        NOW
      )
    ).toBe('unavailable');
    expect(
      mcpSlackConnectRenderedState(
        { widget: widget(), delivery: delivery(), grantConnected: true, refusal: 'unaligned' },
        NOW
      )
    ).toBe('unavailable');
  });

  it('keeps a finish card on the expiry timer and a stalled one off it', () => {
    expect(mcpSlackConnectExpiryDelay('finish_required', delivery(), NOW)).toBe(
      Date.parse(EXPIRES_AT) - NOW + 1_000
    );
    // Nothing left to age: re-minting a link on a timer would edit the same
    // Slack row every ten minutes for a day.
    expect(mcpSlackConnectExpiryDelay('finish_stalled', delivery(), NOW)).toBeUndefined();
  });
});

/**
 * B1 in the thread: the card a user comes back to.
 *
 * Driven through the real delivery loop rather than the state function alone,
 * because the two things that make this recoverable from Slack are the button
 * and the link behind it — and the link is the part the projection has to
 * produce without minting a second one.
 */
describe('Slack MCP connect delivery — finishing an abandoned sign-in', () => {
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

  beforeEach(() => {
    killSwitch.stub = async () => true;
    grantLiveness.live = true;
    grantLiveness.refreshable = false;
  });

  /**
   * A link record on the delivery loop's own clock.
   *
   * The presentation tests above pin a fixed `now`; the loop reads the wall
   * clock, and whether a finish card carries a button turns on whether its
   * link has lapsed — so these have to be positioned around the real one.
   */
  const liveLink = (fields: Partial<MCPSlackConnectDelivery> = {}) => ({
    // Second-aligned, because `issueMCPOAuthConnectLink` second-aligns and
    // this stands in for a record it wrote. The alignment is not cosmetic:
    // redemption compares whole-second `iat`/`exp` against these strings for
    // equality, so an unaligned record is one no link can be re-sealed from.
    // Pinned directly by the two tests below.
    issued_at: new Date(alignedNow() - 5 * 60_000).toISOString(),
    expires_at: new Date(alignedNow() + 5 * 60_000).toISOString(),
    ...fields,
  });

  const alignedNow = () => Math.floor(Date.now() / 1_000) * 1_000;

  it('edits the dead sign-in card into one that finishes, on the link it already has', async () => {
    const harness = deliveryHarness({
      delivery: liveLink({
        slack_message_ts: '1700000000.000002',
        rendered_state: 'sign_in_pending',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_attempt_id: 'attempt-1',
        oauth_started_at: '2026-09-16T12:01:00.000Z',
        oauth_succeeded_at: '2026-09-16T12:02:00.000Z',
      }),
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls.at(-1)![0] as {
      text: string;
      metadata?: Record<string, unknown>;
      blocks: { type: string; elements?: { text?: { text?: string }; url?: string }[] }[];
    };
    // The same Slack row, edited — never a second card beside the first.
    expect(request.metadata).toMatchObject({ slack_update_ts: '1700000000.000002' });
    expect(request.text).toMatch(/Finish connecting Notion/);
    expect(request.text).not.toMatch(/sign in through Agor/i);
    const action = request.blocks.find((block) => block.type === 'actions');
    expect(action?.elements?.[0]?.text?.text).toBe('Finish connecting Notion');
    expect(action?.elements?.[0]?.url).toMatch(/#token=/);

    const after = harness.current();
    expect(after).toMatchObject({ rendered_state: 'finish_required' });
    // Re-sealed, not re-issued: the record keeps its generation, its one-use
    // identity and the outcome that says the sign-in already happened.
    expect(after?.delivery_generation).toBe(1);
    expect(after?.token_jti).toBe('jti-1');
    expect(after?.oauth_succeeded_at).toBe('2026-09-16T12:02:00.000Z');
    expect(after?.token_consumed_at).toBe('2026-09-16T12:01:00.000Z');
  });

  it('offers the finish for a grant whose access token lapsed while the user was away', async () => {
    // D4.1, through the loop that actually renders the card. This is the same
    // user as the test above, an hour later: the sign-in landed, nobody came
    // back to POST, and the access token it produced has since expired —
    // leaving a bound grant with a refresh token the inject hook will spend
    // before the executor sees it.
    //
    // Keying the card on `live` alone reverted it from *Finish connecting* to
    // a buttonless "sign-in is in progress … this message updates when it
    // lands", forever, for the one user this whole lane exists for. The card
    // asks the same verdict `/oauth-resolve` asks, so the button it offers is
    // one the resolver accepts.
    grantLiveness.live = false;
    grantLiveness.refreshable = true;
    const harness = deliveryHarness({
      delivery: liveLink({
        slack_message_ts: '1700000000.000002',
        rendered_state: 'sign_in_pending',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_succeeded_at: '2026-09-16T12:02:00.000Z',
      }),
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls.at(-1)![0] as {
      text: string;
      blocks: { type: string; elements?: { text?: { text?: string }; url?: string }[] }[];
    };
    expect(request.text).toMatch(/Finish connecting Notion/);
    const action = request.blocks.find((block) => block.type === 'actions');
    expect(action?.elements?.[0]?.url).toMatch(/#token=/);
    expect(harness.current()).toMatchObject({ rendered_state: 'finish_required' });
  });

  it('posts a finish link redemption will actually accept', async () => {
    // The promise this whole state rests on is that a card never offers a
    // finish `/oauth-resolve` would refuse. Every other test here checks that
    // a button is PRESENT; this one checks that pressing it works, by taking
    // the URL apart and asking the redemption path's own comparison.
    //
    // It is not a theoretical worry. `mcpOAuthConnectClaimsMatchDelivery`
    // compares the sealed `iat`/`exp` — whole seconds — for EQUALITY against
    // the record's ISO timestamps, so a record whose clocks carry milliseconds
    // produces a token that is refused every time. `issueMCPOAuthConnectLink`
    // second-aligns for exactly that reason, one function away and in a
    // comment; this is what binds the two together.
    const harness = deliveryHarness({
      delivery: liveLink({
        slack_message_ts: '1700000000.000002',
        rendered_state: 'sign_in_pending',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_succeeded_at: '2026-09-16T12:02:00.000Z',
      }),
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls.at(-1)![0] as {
      blocks: { type: string; elements?: { url?: string }[] }[];
    };
    const url = request.blocks.find((block) => block.type === 'actions')?.elements?.[0]?.url;
    const token = decodeURIComponent(new URL(url!).hash.replace('#token=', ''));
    const claims = verifyMCPOAuthConnectToken(token, SECRET);
    expect(mcpOAuthConnectClaimsMatchDelivery(claims, harness.current(), 'tenant-a')).toBe(true);
  });

  it('offers the finish on a claim whose resolver died, not a wait with no end', async () => {
    // The sub-case where the browser got FURTHER before it went away: the
    // resolve POST claimed `pending -> resolving` and then the page (or the
    // daemon) died. `submissions.ts` will let a later POST take that claim
    // over once it is a minute old, and `mcpSlackConnectRenderedState` has an
    // explicit branch to offer the button at exactly that point — but the
    // delivery loop could not reach it, because the binding it needs refuses
    // any widget that is not `pending`. So the card said "sign-in is in
    // progress … this message updates when it lands", forever, with nothing to
    // press and nothing coming.
    const harness = deliveryHarness({
      widget: {
        status: 'resolving',
        resolution_claim: {
          token: 'claim-token',
          action: 'oauth_callback',
          claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          claimed_by: OWNER,
        },
      } as Partial<WidgetMessageMetadata>,
      delivery: liveLink({
        slack_message_ts: '1700000000.000002',
        rendered_state: 'sign_in_pending',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_succeeded_at: '2026-09-16T12:02:00.000Z',
      }),
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls.at(-1)![0] as {
      text: string;
      blocks: { type: string; elements?: { url?: string }[] }[];
    };
    expect(request.text).toMatch(/Finish connecting Notion/);
    const url = request.blocks.find((block) => block.type === 'actions')?.elements?.[0]?.url;
    expect(url).toMatch(/#token=/);
    expect(harness.current()).toMatchObject({ rendered_state: 'finish_required' });
  });

  it('leaves an abandoned dismissal alone rather than editing in a finish', async () => {
    // The same shape as the case above, driven through the real delivery loop,
    // with one field changed: the abandoned claim is a `dismiss`. The loop must
    // reach the same verdict the state function does — no edit, no button, and
    // the record still saying a sign-in is pending — because the URL this card
    // would carry leads to a POST `submissions.ts` refuses by name.
    const harness = deliveryHarness({
      widget: {
        status: 'resolving',
        resolution_claim: {
          token: 'claim-token',
          action: 'dismiss',
          claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          claimed_by: OWNER,
        },
      } as Partial<WidgetMessageMetadata>,
      delivery: liveLink({
        slack_message_ts: '1700000000.000002',
        rendered_state: 'sign_in_pending',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_succeeded_at: '2026-09-16T12:02:00.000Z',
      }),
    });
    await withSecret(() => harness.deliver());
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.current()).toMatchObject({ rendered_state: 'sign_in_pending' });
  });

  it('leaves a claim younger than the takeover cutoff alone', async () => {
    // Two browsers racing the same card must not reclaim from each other, so
    // until the cutoff the honest card is still "in progress".
    const harness = deliveryHarness({
      widget: {
        status: 'resolving',
        resolution_claim: {
          token: 'claim-token',
          action: 'oauth_callback',
          claimed_at: new Date(Date.now() - 5_000).toISOString(),
          claimed_by: OWNER,
        },
      } as Partial<WidgetMessageMetadata>,
      delivery: liveLink({
        slack_message_ts: '1700000000.000002',
        rendered_state: 'sign_in_pending',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_succeeded_at: '2026-09-16T12:02:00.000Z',
      }),
    });
    await withSecret(() => harness.deliver());
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.current()).toMatchObject({ rendered_state: 'sign_in_pending' });
  });

  it('shows no button at all rather than one that cannot be redeemed', async () => {
    // The other side of the same promise. A record whose clocks are not
    // second-aligned is one no acceptable link can be re-sealed from — today
    // only `issueMCPOAuthConnectLink` writes these, and it aligns, so this is
    // the guard rather than a reachable state. It degrades to the honest
    // answer, not to a button that fails: `finish_stalled` tells the reader to
    // ask again in the thread, and asking again costs no second sign-in.
    const harness = deliveryHarness({
      delivery: {
        issued_at: new Date(alignedNow() - 5 * 60_000 + 321).toISOString(),
        expires_at: new Date(alignedNow() + 5 * 60_000 + 321).toISOString(),
        slack_message_ts: '1700000000.000002',
        rendered_state: 'sign_in_pending',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_succeeded_at: '2026-09-16T12:02:00.000Z',
      },
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls.at(-1)![0] as {
      text: string;
      blocks: { type: string }[];
    };
    expect(request.blocks.some((block) => block.type === 'actions')).toBe(false);
    expect(request.text).toMatch(/will not have to sign in again/i);
    expect(harness.current()).toMatchObject({ rendered_state: 'finish_stalled' });
    // And it settles there. Deciding this before the steady-state shortcut is
    // what stops a card the lane cannot produce a link for from being redrawn
    // on every repair tick.
    await withSecret(() => harness.deliver());
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('drops the button once the link lapses, and says asking again is free', async () => {
    const harness = deliveryHarness({
      delivery: {
        slack_message_ts: '1700000000.000002',
        rendered_state: 'finish_required',
        expires_at: '2026-09-16T11:50:00.000Z',
        token_consumed_at: '2026-09-16T11:41:00.000Z',
        oauth_succeeded_at: '2026-09-16T11:42:00.000Z',
      },
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls.at(-1)![0] as {
      text: string;
      blocks: { type: string }[];
    };
    expect(request.blocks.some((block) => block.type === 'actions')).toBe(false);
    expect(request.text).toMatch(/will not have to sign in again/i);
    expect(harness.current()).toMatchObject({ rendered_state: 'finish_stalled' });
    // Terminal until someone asks again: nothing re-mints a link on a timer.
    expect(harness.current()?.next_repair_at).toBeUndefined();
  });

  it('does not churn the card once it has been repainted as a finish', async () => {
    const harness = deliveryHarness({
      delivery: liveLink({
        slack_message_ts: '1700000000.000002',
        rendered_state: 'finish_required',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_succeeded_at: '2026-09-16T12:02:00.000Z',
      }),
    });
    await withSecret(() => harness.deliver());
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('prefers finishing over re-offering a sign-in the user no longer needs', async () => {
    // A durably failed sign-in may be re-offered once (§7.2) — but not when
    // the credential is already on file, where a fresh sign-in link would be
    // both pointless and a second token to reconcile.
    const harness = deliveryHarness({
      delivery: liveLink({
        slack_message_ts: '1700000000.000002',
        rendered_state: 'expired',
        token_consumed_at: '2026-09-16T12:01:00.000Z',
        oauth_failed_at: '2026-09-16T12:02:00.000Z',
      }),
    });
    await withSecret(() => harness.deliver());

    const request = harness.sendMessage.mock.calls.at(-1)![0] as { text: string };
    expect(request.text).toMatch(/Finish connecting Notion/);
    expect(harness.current()).toMatchObject({
      rendered_state: 'finish_required',
      delivery_generation: 1,
      token_jti: 'jti-1',
    });
  });
});
