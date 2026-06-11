import type { MCPServer } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { summarizeSessionMcpServers } from './mcp-session-summary';

const server = (id: string, auth?: MCPServer['auth']): MCPServer =>
  ({
    mcp_server_id: id,
    name: id,
    display_name: id,
    enabled: true,
    transport: 'http',
    scope: 'global',
    auth,
  }) as MCPServer;

describe('summarizeSessionMcpServers', () => {
  it('summarizes empty sessions', () => {
    expect(summarizeSessionMcpServers([], new Map(), new Set())).toMatchObject({
      attachedCount: 0,
      healthyCount: 0,
      tone: 'default',
      label: 'MCP (0)',
    });
  });

  it('uses warning tone when attached OAuth servers need user auth', () => {
    const servers = new Map([['s1', server('s1', { type: 'oauth', oauth_mode: 'per_user' })]]);

    expect(summarizeSessionMcpServers(['s1'], servers, new Set())).toMatchObject({
      attachedCount: 1,
      needsAuthCount: 1,
      missingCount: 0,
      healthyCount: 0,
      tone: 'warning',
    });
  });

  it('uses error tone when an attached server record is missing', () => {
    expect(summarizeSessionMcpServers(['missing'], new Map(), new Set())).toMatchObject({
      attachedCount: 1,
      needsAuthCount: 0,
      missingCount: 1,
      tone: 'error',
    });
  });
});
