import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('executor MCP custom headers wiring', () => {
  it('merges custom headers with auth headers for Claude remote MCP servers', () => {
    const source = readFileSync(new URL('./claude/query-builder.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      'mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders })'
    );
    expect(source).toContain('serverConfig.headers = headers');
  });

  it('merges custom headers with auth headers for Cursor remote MCP servers', () => {
    const source = readFileSync(new URL('../handlers/sdk/cursor.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      'mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders })'
    );
    expect(source).toContain('...(headers ? { headers } : {})');
  });
});
