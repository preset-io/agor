import { describe, expect, it } from 'vitest';
import {
  resolveQuickStartMcpServerIds,
  resolveSessionMcpServerIds,
} from './resolveQuickStartMcpServerIds';

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

describe('resolveSessionMcpServerIds', () => {
  it('applies the same branch > user precedence', () => {
    const branch = { mcp_server_ids: ['branch-mcp'] };
    expect(resolveSessionMcpServerIds(['user-mcp'], branch)).toEqual(['branch-mcp']);
    expect(resolveSessionMcpServerIds(['user-mcp'], { mcp_server_ids: [] })).toEqual(['user-mcp']);
  });

  it('stays undefined when neither source is set, leaving the fallback to the daemon', () => {
    expect(resolveSessionMcpServerIds(undefined, null)).toBeUndefined();
  });
});
