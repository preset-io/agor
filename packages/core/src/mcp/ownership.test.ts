import { describe, expect, it } from 'vitest';
import { isMCPServerNotUsableError, MCPServerNotUsableError } from './ownership';

describe('MCP ownership error boundary', () => {
  it('recognizes a domain error from a different bundle, not by class identity', () => {
    const original = new MCPServerNotUsableError('server', 'session');
    const foreign = Object.assign(new Error(original.message), {
      name: original.name,
      code: original.code,
      serverId: 'server',
      sessionId: 'session',
    });
    expect(foreign).not.toBeInstanceOf(MCPServerNotUsableError);
    expect(isMCPServerNotUsableError(original)).toBe(true);
    expect(isMCPServerNotUsableError(foreign)).toBe(true);
    expect(isMCPServerNotUsableError(new Error(original.message))).toBe(false);
    expect(isMCPServerNotUsableError({ name: original.name })).toBe(false);
    expect(isMCPServerNotUsableError(null)).toBe(false);
  });
});
