import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * DELETE users locks the user row before its FK cascade reaches pending flows.
 * create() must therefore take the initiating user's KEY SHARE lock before it
 * writes any pending-flow row, as UserMCPOAuthTokenRepository.saveToken() does.
 */
describe('MCP OAuth pending-flow create() lock order', () => {
  it('locks subject, then user KEY SHARE, then supersedes, then inserts', () => {
    const source = readFileSync(new URL('./mcp-oauth-pending-flows.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async create(input: MCPOAuthPendingFlowCreate)');
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    const positions = [
      body.indexOf('await this.lockGrantSubject(input);'),
      body.indexOf('FOR KEY SHARE'),
      body.indexOf('UPDATE ${mcpOauthPendingFlows}'),
      body.indexOf('await insert(this.db, mcpOauthPendingFlows)'),
    ];
    expect(start).toBeGreaterThan(-1);
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
