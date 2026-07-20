import { describe, expect, it } from 'vitest';
import { resolveQuickStartMcpServerIds } from './resolveQuickStartMcpServerIds';

describe('resolveQuickStartMcpServerIds', () => {
  it('prefers branch-level MCP servers over user defaults', () => {
    const result = resolveQuickStartMcpServerIds(
      { default_mcp_server_ids: ['user-mcp'] },
      { mcp_server_ids: ['branch-mcp'] }
    );
    expect(result).toEqual(['branch-mcp']);
  });

  it('falls back to the user default when branch has none', () => {
    const result = resolveQuickStartMcpServerIds(
      { default_mcp_server_ids: ['user-mcp'] },
      { mcp_server_ids: [] }
    );
    expect(result).toEqual(['user-mcp']);
  });

  it('returns an empty array when neither branch nor user has a default', () => {
    expect(resolveQuickStartMcpServerIds(null, null)).toEqual([]);
  });
});
