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

  it('shows a clear short fallback for a selected server missing from hydration', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(buildMcpServerOptions([], [id])).toEqual([
      { label: 'Unavailable MCP server (aaaaaaaabbbbccccddddeeee)', value: id, disabled: true },
    ]);
  });
});
