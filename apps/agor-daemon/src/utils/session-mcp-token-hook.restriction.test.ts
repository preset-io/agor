import { NotAuthenticated } from '@agor/core/feathers';
import type { Session } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

const generateSessionToken = vi.hoisted(() => vi.fn());
vi.mock('../mcp/tokens.js', () => ({ generateSessionToken }));

import { createSessionMcpTokenHook } from './session-mcp-token-hook.js';

const session = { session_id: 'session-1' } as Session;
const hook = createSessionMcpTokenHook({
  app: { settings: { authentication: { secret: 'secret' } } } as never,
  config: {},
});
const run = () =>
  hook({
    params: { user: { user_id: 'user-1', role: 'member' } },
    result: session,
  } as never);

describe('sessions MCP-token hook restriction reads', () => {
  it('returns the session without a token when the restriction read fails', async () => {
    generateSessionToken.mockRejectedValueOnce(
      new NotAuthenticated('Tenant credential cannot be verified')
    );
    const context = await run();
    expect(context.result).toBe(session);
    expect(context.result).not.toHaveProperty('mcp_token');
  });

  it('still surfaces minting failures that are not about tenant state', async () => {
    generateSessionToken.mockRejectedValueOnce(new Error('MCP token generation failed'));
    await expect(run()).rejects.toThrow('MCP token generation failed');
  });
});
