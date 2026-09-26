import type {
  GatewayChannel,
  MCPServer,
  MCPServerID,
  Message,
  MessageID,
  Session,
  SessionID,
  Task,
  User,
  UserID,
} from '@agor/core/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  mcpOAuthConnectClaimsMatchDelivery,
  verifyMCPOAuthConnectToken,
} from '../utils/mcp-oauth-connect-token.js';
import {
  gatewaySourceMatchesConnectClaims,
  issueMCPOAuthConnectLink,
  type MCPOAuthConnectLinkDeps,
  mutateSlackConnectDelivery,
  readPendingOAuthConnectWidget,
  resolveSlackConnectBinding,
} from './mcp-oauth-connect-delivery.js';
import type { SlackMCPOAuthAuthorityRepositories } from './mcp-slack-oauth-authority.js';

const SECRET = 'connect-delivery-test-master-secret';
const WIDGET_ID = 'widget-1' as MessageID;
const SESSION_ID = 'session-1' as SessionID;
const SERVER_ID = 'server-1' as MCPServerID;
const OWNER = 'user-1' as UserID;
const THREAD = 'C123-1724688000.000100';

function widgetMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: WIDGET_ID,
    session_id: SESSION_ID,
    task_id: 'task-1',
    type: 'widget_request',
    metadata: {
      widget: {
        widget_type: 'oauth',
        widget_id: WIDGET_ID,
        schema_version: 1,
        status: 'pending',
        requested_at: '2026-09-16T11:00:00.000Z',
        params: {
          mcpServerId: SERVER_ID,
          serverName: 'Notion',
          oauthMode: 'per_user',
          reason: 'Read the roadmap page.',
        },
      },
    },
    ...overrides,
  } as unknown as Message;
}

function gatewayTask(overrides: Partial<Task['metadata']> = {}): Task {
  return {
    task_id: 'task-1',
    session_id: SESSION_ID,
    created_by: OWNER,
    metadata: {
      gateway_task_source: {
        gateway_channel_id: 'gateway-1',
        channel_type: 'slack',
        thread_id: THREAD,
        provider_user_id: 'U123',
        slack_team_id: 'T123',
        slack_channel_id: 'C123',
      },
      ...overrides,
    },
  } as unknown as Task;
}

/** In-memory `mutateMetadataLocked`, faithful to the real CAS contract. */
function messageStore(initial: Message) {
  let current = initial;
  return {
    read: () => current,
    findById: async (id: MessageID) => (id === current.message_id ? current : null),
    mutateMetadataLocked: async (
      id: MessageID,
      mutation: (metadata: Message['metadata'], message: Message) => Message['metadata'] | null
    ) => {
      if (id !== current.message_id) throw new Error(`Message ${id} not found`);
      const next = mutation(current.metadata, current);
      if (next === null) return { changed: false, message: current };
      current = { ...current, metadata: next };
      return { changed: true, message: current };
    },
  };
}

function repositories(
  overrides: {
    channel?: Partial<GatewayChannel>;
    server?: Partial<MCPServer>;
    session?: Partial<Session>;
    user?: Partial<User>;
  } = {}
): SlackMCPOAuthAuthorityRepositories {
  return {
    sessions: {
      findById: async () =>
        ({ session_id: SESSION_ID, created_by: OWNER, ...overrides.session }) as Session,
    },
    users: {
      findById: async () => ({ user_id: OWNER, role: 'member', ...overrides.user }) as User,
    },
    channels: {
      findById: async () =>
        ({
          id: 'gateway-1',
          enabled: true,
          channel_type: 'slack',
          provider_config_generation: 7,
          config: { align_slack_users: true },
          ...overrides.channel,
        }) as GatewayChannel,
    },
    servers: {
      findById: async () =>
        ({
          mcp_server_id: SERVER_ID,
          enabled: true,
          config_version: 3,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
          ...overrides.server,
        }) as MCPServer,
    },
    threadMap: {
      findBySession: async () => ({ channel_id: 'gateway-1', thread_id: THREAD }),
    },
  } as unknown as SlackMCPOAuthAuthorityRepositories;
}

describe('Slack MCP connect delivery', () => {
  let store: ReturnType<typeof messageStore>;
  let deps: MCPOAuthConnectLinkDeps;

  beforeEach(() => {
    store = messageStore(widgetMessage());
    deps = {
      repositories: repositories(),
      messages: store,
      tasks: { findById: async () => gatewayTask() },
      masterSecret: SECRET,
      baseUrl: 'https://agor.example.test',
    };
  });

  /**
   * The two ingredients a link needs from the DEPLOYMENT, refused the same way.
   *
   * `no_secret` has always been classified here rather than thrown, and it is
   * the template the base URL now follows. An unbuildable base URL used to
   * throw on the delivery's first line instead — above the refusal classifier,
   * the marker reschedule and the claim — which is why one missing argument
   * presented as an unbounded thirty-second retry and a `reason=unexpected`.
   *
   * `http://localhost:3030` is in the table because it is the condition
   * nothing checked: it is what a deployment that never configured a public
   * URL falls back to, it reads as a perfectly good URL, and the card it posts
   * carries a button that works for nobody in the thread.
   */
  it.each([
    ['no master secret', { masterSecret: '' }, 'no_secret'],
    ['an uninitialised hosted tenant', { baseUrl: '' }, 'no_public_url'],
    ['the localhost fallback', { baseUrl: 'http://localhost:3030' }, 'no_public_url'],
    ['a bind address', { baseUrl: 'http://0.0.0.0:3030' }, 'no_public_url'],
  ])('refuses the binding for %s', async (_label, patch, reason) => {
    const binding = await resolveSlackConnectBinding({ ...deps, ...patch }, WIDGET_ID);

    expect(binding.ok).toBe(false);
    expect(binding.ok === false && binding.reason).toBe(reason);
    // Refused, not thrown, and with the card's thread still known — which is
    // what lets the projection keep the widget's durable trigger rather than
    // dropping it.
    expect(binding.slack).toBeDefined();
  });

  it('mints a fragment-only link whose claims bind the widget and the Slack sender', async () => {
    const issued = await issueMCPOAuthConnectLink(deps, {
      tenantId: 'tenant-1',
      widgetId: WIDGET_ID,
    });
    expect(issued).not.toBeNull();
    const [page, fragment] = issued!.url.split('#');
    expect(page).toBe('https://agor.example.test/ui/connect/mcp');
    expect(fragment.startsWith('token=')).toBe(true);
    // The token lives in the fragment and nowhere else: no query string, no
    // path segment, nothing that would reach a server log or a Referer.
    expect(page).not.toContain('token');

    const claims = verifyMCPOAuthConnectToken(
      decodeURIComponent(fragment.slice('token='.length)),
      SECRET
    );
    expect(claims).toMatchObject({
      tid: 'tenant-1',
      widget_id: WIDGET_ID,
      session_id: SESSION_ID,
      mcp_server_id: SERVER_ID,
      slack_user_id: 'U123',
      task_id: 'task-1',
      session_owner_user_id: OWNER,
      credential_user_id: OWNER,
      delivery_generation: 1,
      mcp_server_config_version: 3,
      gateway_config_generation: 7,
    });
    expect(store.read().metadata?.widget?.slack_connect?.token_jti).toBe(claims.jti);
  });

  it('mints claims that still match the stored record at a ragged wall clock', async () => {
    // Regression: the sealed claims carry whole-second `iat`/`exp` while the
    // delivery record stores ISO timestamps, and redemption compares them for
    // equality. A mint at a millisecond-precision clock used to produce a link
    // that every redemption refused.
    //
    // The ragged clock is built relative to now rather than pinned to a
    // literal instant: `verifyMCPOAuthConnectToken` below reads the real
    // system clock, so a hardcoded date only passes inside the token's
    // ten-minute TTL of whenever the test was written.
    const raggedNow = new Date(Math.floor(Date.now() / 1_000) * 1_000 + 201);
    const issued = await issueMCPOAuthConnectLink(deps, {
      tenantId: 'tenant-1',
      widgetId: WIDGET_ID,
      now: raggedNow,
    });
    expect(raggedNow.getMilliseconds()).toBe(201);
    const claims = verifyMCPOAuthConnectToken(
      decodeURIComponent(issued!.url.split('#token=')[1]),
      SECRET
    );
    expect(mcpOAuthConnectClaimsMatchDelivery(claims, issued!.delivery, 'tenant-1')).toBe(true);
  });

  it('supersedes an earlier link by bumping the delivery generation', async () => {
    const first = await issueMCPOAuthConnectLink(deps, {
      tenantId: 'tenant-1',
      widgetId: WIDGET_ID,
    });
    const second = await issueMCPOAuthConnectLink(deps, {
      tenantId: 'tenant-1',
      widgetId: WIDGET_ID,
    });
    expect(first!.delivery.delivery_generation).toBe(1);
    expect(second!.delivery.delivery_generation).toBe(2);
    // Same delivery identity, new one-use token: the old link is now stale
    // against the stored record, which is what the redemption compares.
    expect(second!.delivery.delivery_id).toBe(first!.delivery.delivery_id);
    expect(second!.delivery.token_jti).not.toBe(first!.delivery.token_jti);
  });

  it.each([
    [
      'a resolved widget',
      () => {
        store = messageStore(
          widgetMessage({
            metadata: {
              widget: {
                ...widgetMessage().metadata!.widget!,
                status: 'submitted',
              },
            },
          } as Partial<Message>)
        );
        deps = { ...deps, messages: store };
      },
    ],
    [
      'a channel with user alignment switched off',
      () => {
        deps = {
          ...deps,
          repositories: repositories({ channel: { config: { align_slack_users: false } } }),
        };
      },
    ],
    [
      'a server private to another user',
      () => {
        deps = {
          ...deps,
          repositories: repositories({ server: { owner_user_id: 'user-2' as UserID } }),
        };
      },
    ],
    [
      'a non-Slack originating task',
      () => {
        deps = {
          ...deps,
          tasks: {
            findById: async () =>
              ({
                ...gatewayTask(),
                metadata: {
                  gateway_task_source: {
                    gateway_channel_id: 'gateway-1',
                    channel_type: 'discord',
                    thread_id: THREAD,
                    provider_user_id: 'U123',
                  },
                },
              }) as Task,
          },
        };
      },
    ],
    [
      'a session with no gateway origin at all',
      () => {
        deps = { ...deps, tasks: { findById: async () => ({ ...gatewayTask(), metadata: {} }) } };
      },
    ],
    [
      'a deployment with no master secret',
      () => {
        deps = { ...deps, masterSecret: '' };
      },
    ],
  ])('refuses to issue for %s', async (_name, mutate) => {
    mutate();
    await expect(
      issueMCPOAuthConnectLink(deps, { tenantId: 'tenant-1', widgetId: WIDGET_ID })
    ).resolves.toBeNull();
  });

  it('reads only a pending oauth widget as connectable', () => {
    expect(readPendingOAuthConnectWidget(widgetMessage())).not.toBeNull();
    expect(readPendingOAuthConnectWidget(null)).toBeNull();
    expect(
      readPendingOAuthConnectWidget({ ...widgetMessage(), type: 'text' } as Message)
    ).toBeNull();
    const envVars = widgetMessage();
    envVars.metadata!.widget!.widget_type = 'env_vars';
    expect(readPendingOAuthConnectWidget(envVars)).toBeNull();
    const mismatched = widgetMessage();
    mismatched.metadata!.widget!.widget_id = 'other' as MessageID;
    expect(readPendingOAuthConnectWidget(mismatched)).toBeNull();
  });

  it('holds the one-use CAS against a second consumer', async () => {
    await issueMCPOAuthConnectLink(deps, { tenantId: 'tenant-1', widgetId: WIDGET_ID });
    const consume = () =>
      mutateSlackConnectDelivery(store, WIDGET_ID, (current) =>
        current && !current.token_consumed_at
          ? { ...current, token_consumed_at: '2026-09-16T12:01:00.000Z' }
          : null
      );
    await expect(consume()).resolves.toMatchObject({ changed: true });
    await expect(consume()).resolves.toMatchObject({ changed: false });
  });

  it('pins the Slack sender against the originating task', () => {
    const claims = {
      gateway_channel_id: 'gateway-1',
      slack_thread_id: THREAD,
      slack_user_id: 'U123',
      slack_team_id: 'T123',
      slack_channel_id: 'C123',
      session_id: SESSION_ID,
      credential_user_id: OWNER,
    } as Parameters<typeof gatewaySourceMatchesConnectClaims>[1];
    expect(gatewaySourceMatchesConnectClaims(gatewayTask(), claims)).toBe(true);
    // A different Slack person tapping the same link in a shared thread.
    expect(
      gatewaySourceMatchesConnectClaims(gatewayTask(), { ...claims, slack_user_id: 'U999' })
    ).toBe(false);
    // The prompt was attributed to somebody else.
    expect(
      gatewaySourceMatchesConnectClaims(gatewayTask(), {
        ...claims,
        credential_user_id: 'user-2' as UserID,
      })
    ).toBe(false);
    expect(gatewaySourceMatchesConnectClaims(null, claims)).toBe(false);
  });
});
