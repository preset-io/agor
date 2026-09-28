import { describe, expect, it } from 'vitest';
import { resolveSessionMcpServerIds } from './resolveQuickStartMcpServerIds';

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
