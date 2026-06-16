import type { Branch, GatewayChannel, User } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { resolveGatewaySessionDefaults } from './gateway';

function makeChannel(overrides: Partial<GatewayChannel> = {}): GatewayChannel {
  return {
    id: 'channel-1',
    created_by: 'user-1',
    name: 'Slack Gateway',
    channel_type: 'slack',
    target_branch_id: 'branch-1',
    agor_user_id: 'user-1',
    channel_key: 'secret',
    config: {},
    agentic_config: { agent: 'claude-code' },
    enabled: true,
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
    last_message_at: null,
    ...overrides,
  } as GatewayChannel;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    role: 'member',
    default_agentic_config: {
      'claude-code': { mcpServerIds: ['user-mcp'] },
    },
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
    ...overrides,
  } as User;
}

function makeBranch(overrides: Partial<Branch> = {}): Pick<Branch, 'mcp_server_ids'> {
  return {
    mcp_server_ids: ['branch-mcp'],
    ...overrides,
  } as Pick<Branch, 'mcp_server_ids'>;
}

describe('resolveGatewaySessionDefaults', () => {
  it('inherits BranchModal default MCP servers when the gateway channel has no MCP override', () => {
    const resolved = resolveGatewaySessionDefaults({
      channel: makeChannel({ agentic_config: { agent: 'claude-code' } }),
      user: makeUser(),
      branch: makeBranch({ mcp_server_ids: ['branch-mcp-1', 'branch-mcp-2'] }),
    });

    expect(resolved.mcpServerIds).toEqual(['branch-mcp-1', 'branch-mcp-2']);
  });

  it('treats an empty gateway MCP array as form-default/no override when branch MCP defaults exist', () => {
    const resolved = resolveGatewaySessionDefaults({
      channel: makeChannel({ agentic_config: { agent: 'claude-code', mcpServerIds: [] } }),
      user: makeUser(),
      branch: makeBranch({ mcp_server_ids: ['branch-mcp'] }),
    });

    expect(resolved.mcpServerIds).toEqual(['branch-mcp']);
  });

  it('preserves non-empty gateway MCP selections as explicit channel overrides', () => {
    const resolved = resolveGatewaySessionDefaults({
      channel: makeChannel({
        agentic_config: { agent: 'claude-code', mcpServerIds: ['gateway-mcp'] },
      }),
      user: makeUser(),
      branch: makeBranch({ mcp_server_ids: ['branch-mcp'] }),
    });

    expect(resolved.mcpServerIds).toEqual(['gateway-mcp']);
  });

  it('lets an empty gateway MCP array suppress user defaults when the branch has no MCP defaults', () => {
    const resolved = resolveGatewaySessionDefaults({
      channel: makeChannel({ agentic_config: { agent: 'claude-code', mcpServerIds: [] } }),
      user: makeUser(),
      branch: makeBranch({ mcp_server_ids: [] }),
    });

    expect(resolved.mcpServerIds).toEqual([]);
  });
});
