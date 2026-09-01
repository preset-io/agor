import type { MCPServer } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { buildMcpServerOptions } from './MCPServerSelect';

const server = (overrides: Partial<MCPServer>): MCPServer =>
  ({
    mcp_server_id: '11111111-2222-3333-4444-555555555555',
    name: 'internal-name',
    display_name: 'Friendly server',
    transport: 'http',
    enabled: true,
    scope: 'global',
    ...overrides,
  }) as MCPServer;

describe('buildMcpServerOptions', () => {
  it('uses the friendly display name rather than the UUID', () => {
    const options = buildMcpServerOptions([server({})]);
    expect(options[0]?.label).toContain('Friendly server');
    expect(options[0]?.label).not.toContain('11111111-2222');
  });

  it('keeps a selected disabled server labelled', () => {
    const disabled = server({ enabled: false });
    const options = buildMcpServerOptions([disabled], [disabled.mcp_server_id]);
    expect(options).toEqual([
      expect.objectContaining({
        label: expect.stringContaining('Friendly server'),
        value: disabled.mcp_server_id,
        disabled: true,
      }),
    ]);
  });

  // Connecting a marketplace entry writes the install before anybody signs in,
  // so an OAuth row with no grant is enabled and offered here looking exactly
  // like a working one. These pin that the picker says otherwise, using the
  // same `mcpServerNeedsAuth` the session footer and the settings table use.
  it('marks an OAuth server the user has never signed in to', () => {
    const oauth = server({ auth: { type: 'oauth' } } as Partial<MCPServer>);
    const [option] = buildMcpServerOptions([oauth], [], new Set());
    expect(option?.label).toContain('Not signed in');
    // Still selectable: the fix for an unfinished install is to finish it, and
    // detaching it from the session is not that.
    expect(option?.disabled).toBe(false);
  });

  it('leaves a signed-in OAuth server unmarked', () => {
    const oauth = server({ auth: { type: 'oauth' } } as Partial<MCPServer>);
    const [option] = buildMcpServerOptions([oauth], [], new Set([oauth.mcp_server_id]));
    expect(option?.label).not.toContain('Not signed in');
  });

  it('does not trust an OAuth token projected onto a generic server read', () => {
    const oauth = server({
      auth: {
        type: 'oauth',
        oauth_access_token: '••••••••',
        oauth_token_expires_at: 4102444800000,
      },
    } as Partial<MCPServer>);
    expect(buildMcpServerOptions([oauth])[0]?.label).toContain('Not signed in');
  });

  it('leaves a non-OAuth server unmarked', () => {
    expect(buildMcpServerOptions([server({})])[0]?.label).not.toContain('Not signed in');
  });

  it('keeps a selected server missing from hydration labelled and removable', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(buildMcpServerOptions([], [id])).toEqual([
      { label: 'Unavailable MCP server (aaaaaaaabbbbccccddddeeee)', value: id, disabled: false },
    ]);
  });
});
