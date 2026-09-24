import type {
  GatewayChannel,
  MCPServer,
  MCPServerID,
  Session,
  SessionID,
  User,
  UserID,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  readSlackMCPOAuthAuthority,
  type SlackMCPOAuthAuthorityBinding,
  type SlackMCPOAuthAuthorityRepositories,
  slackThreadReturnUrl,
  slackThreadWriteTargetAllowed,
} from './mcp-slack-oauth-authority.js';

const SESSION_ID = 'session-1' as SessionID;
const SERVER_ID = 'server-1' as MCPServerID;
const PRINCIPAL = 'user-1' as UserID;
const THREAD = 'C123-1724688000.000100';

function binding(
  overrides: Partial<SlackMCPOAuthAuthorityBinding> = {}
): SlackMCPOAuthAuthorityBinding {
  return {
    principalUserId: PRINCIPAL,
    credentialUserId: PRINCIPAL,
    sessionId: SESSION_ID,
    gatewayChannelId: 'gateway-1',
    gatewayConfigGeneration: 7,
    slackChannelId: 'C123',
    slackThreadId: THREAD,
    mcpServerId: SERVER_ID,
    mcpServerConfigVersion: 3,
    ...overrides,
  };
}

interface Fixtures {
  session?: Partial<Session> | null;
  user?: Partial<User> | null;
  channel?: Partial<GatewayChannel> | null;
  server?: Partial<MCPServer> | null;
  mapping?: { channel_id: string; thread_id: string } | null;
}

function repositories(fixtures: Fixtures = {}): SlackMCPOAuthAuthorityRepositories {
  const session =
    fixtures.session === null
      ? null
      : ({ session_id: SESSION_ID, created_by: PRINCIPAL, ...fixtures.session } as Session);
  const user =
    fixtures.user === null
      ? null
      : ({ user_id: PRINCIPAL, role: 'member', ...fixtures.user } as User);
  const channel =
    fixtures.channel === null
      ? null
      : ({
          id: 'gateway-1',
          enabled: true,
          channel_type: 'slack',
          provider_config_generation: 7,
          config: { align_slack_users: true },
          ...fixtures.channel,
        } as GatewayChannel);
  const server =
    fixtures.server === null
      ? null
      : ({
          mcp_server_id: SERVER_ID,
          enabled: true,
          config_version: 3,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
          ...fixtures.server,
        } as MCPServer);
  const mapping =
    fixtures.mapping === null
      ? null
      : { channel_id: 'gateway-1', thread_id: THREAD, ...fixtures.mapping };
  return {
    sessions: { findById: async () => session },
    users: { findById: async () => user },
    channels: { findById: async () => channel },
    servers: { findById: async () => server },
    threadMap: { findBySession: async () => mapping },
  } as unknown as SlackMCPOAuthAuthorityRepositories;
}

describe('shared Slack MCP OAuth authority read', () => {
  it('returns the exact proven rows when every binding still holds', async () => {
    const authority = await readSlackMCPOAuthAuthority(repositories(), binding());
    expect(authority?.session.session_id).toBe(SESSION_ID);
    expect(authority?.server.mcp_server_id).toBe(SERVER_ID);
    expect(authority?.channel.id).toBe('gateway-1');
  });

  it.each<[string, Fixtures | SlackMCPOAuthAuthorityBinding]>([
    ['a missing session', { session: null }],
    ['a missing user row', { user: null }],
    ['a disabled channel', { channel: { enabled: false } }],
    ['a non-Slack channel', { channel: { channel_type: 'discord' } }],
    ['a channel reconfigured since issue', { channel: { provider_config_generation: 8 } }],
    [
      'a thread no longer an allowed write target',
      { channel: { config: { allowed_channel_ids: ['C999'] } } },
    ],
    ['a remapped thread', { mapping: { channel_id: 'gateway-1', thread_id: 'C123-999.1' } }],
    [
      'a thread mapped to another channel',
      { mapping: { channel_id: 'gateway-2', thread_id: THREAD } },
    ],
    ['a disabled server', { server: { enabled: false } }],
    ['a server converted away from OAuth', { server: { auth: { type: 'bearer' } } }],
    ['a server edited since issue', { server: { config_version: 4 } }],
  ])('refuses %s', async (_name, fixtures) => {
    await expect(
      readSlackMCPOAuthAuthority(repositories(fixtures as Fixtures), binding())
    ).resolves.toBeNull();
  });

  /**
   * `'current'` is the issue-time caller's shape: there is no earlier claim to
   * compare against, so the version check is vacuous by design. It is a value
   * rather than a re-read of the row precisely so the vacuous case cannot be
   * confused with a real one at a call site — the spelling it replaced (read
   * the channel, hand its own generation back in) looked like a check.
   */
  it('admits any stored version for `current`, and still refuses a pinned mismatch', async () => {
    const moved: Fixtures = {
      channel: { provider_config_generation: 8 },
      server: { config_version: 4 },
    };
    await expect(
      readSlackMCPOAuthAuthority(
        repositories(moved),
        binding({ gatewayConfigGeneration: 'current', mcpServerConfigVersion: 'current' })
      )
    ).resolves.not.toBeNull();

    // Only the vacuous request is vacuous. A sealed number is still compared,
    // one field at a time, which is the check this module exists for.
    await expect(
      readSlackMCPOAuthAuthority(
        repositories(moved),
        binding({ gatewayConfigGeneration: 7, mcpServerConfigVersion: 'current' })
      )
    ).resolves.toBeNull();
    await expect(
      readSlackMCPOAuthAuthority(
        repositories(moved),
        binding({ gatewayConfigGeneration: 'current', mcpServerConfigVersion: 3 })
      )
    ).resolves.toBeNull();
  });

  it('raises the credential floor to admin for a shared-mode server', async () => {
    const shared: Fixtures = { server: { auth: { type: 'oauth', oauth_mode: 'shared' } } };
    // The floor is read from the STORED row, not from anything the token said,
    // so flipping a server to shared starts demanding an admin immediately.
    await expect(readSlackMCPOAuthAuthority(repositories(shared), binding())).resolves.toBeNull();
    await expect(
      readSlackMCPOAuthAuthority(repositories({ ...shared, user: { role: 'admin' } }), binding())
    ).resolves.not.toBeNull();
  });

  it('refuses a token whose channel and thread disagree', () => {
    expect(slackThreadWriteTargetAllowed(THREAD, 'C123', {})).toBe(true);
    expect(slackThreadWriteTargetAllowed(THREAD, 'C999', {})).toBe(false);
    expect(slackThreadWriteTargetAllowed('not-a-thread', 'C123', {})).toBe(false);
  });

  it('builds a return link with and without a root timestamp', () => {
    expect(slackThreadReturnUrl('T1', 'C1', 'C1-1724688000.000100')).toBe(
      'slack://channel?team=T1&id=C1&message=1724688000.000100'
    );
    expect(slackThreadReturnUrl('T1', 'C1', 'C1')).toBe('slack://channel?team=T1&id=C1');
  });
});
