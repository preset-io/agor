import { NotAuthenticated, Unavailable } from '@agor/core/feathers';
import { type Session, TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

const generateSessionToken = vi.hoisted(() => vi.fn());
const hasTerminationReadAuthority = vi.hoisted(() => vi.fn(() => false));
vi.mock('../mcp/tokens.js', () => ({ generateSessionToken }));
vi.mock('../auth/termination-read-authority.js', () => ({ hasTerminationReadAuthority }));

import { readAdmittedTenantRestriction } from '../auth/tenant-access.js';
import {
  createSessionMcpTokenHook,
  skipsSessionMcpToken,
  withoutSessionMcpToken,
} from './session-mcp-token-hook.js';

const session = { session_id: 'session-1' } as Session;
const hook = createSessionMcpTokenHook({
  app: { settings: { authentication: { secret: 'secret' } } } as never,
  config: {},
});
const run = (method = 'get', provider: string | null = 'socketio') =>
  hook({
    method,
    params: { user: { user_id: 'user-1', role: 'member' }, provider: provider ?? undefined },
    result: session,
  } as never);
const readFailure = () => new Unavailable('Tenant credential cannot be verified');

describe('sessions MCP-token hook restriction reads', () => {
  it('issues from the read that admitted the request', async () => {
    generateSessionToken.mockResolvedValueOnce('token');
    const context = await run();
    expect(context.result).toMatchObject({ mcp_token: 'token' });
    expect(generateSessionToken).toHaveBeenLastCalledWith(
      expect.anything(),
      'session-1',
      'user-1',
      readAdmittedTenantRestriction
    );
  });

  it('fails an ordinary session read as unavailable instead of returning it without a token', async () => {
    generateSessionToken.mockRejectedValueOnce(readFailure());
    await expect(run()).rejects.toBeInstanceOf(Unavailable);
  });

  it('returns an internal session read without a token when the restriction read fails', async () => {
    generateSessionToken.mockRejectedValueOnce(readFailure());
    const context = await run('get', null);
    expect(context.result).toBe(session);
    expect(context.result).not.toHaveProperty('mcp_token');
  });

  it('returns a committed create without a token when the restriction read fails', async () => {
    generateSessionToken.mockRejectedValueOnce(readFailure());
    const context = await run('create');
    expect(context.result).toBe(session);
  });

  it('returns a termination read without a token when the restriction read fails', async () => {
    hasTerminationReadAuthority.mockReturnValueOnce(true);
    generateSessionToken.mockRejectedValueOnce(readFailure());
    const context = await run();
    expect(context.result).toBe(session);
    expect(context.result).not.toHaveProperty('mcp_token');
  });

  it('returns the session without a token for a closed tenant', async () => {
    generateSessionToken.mockRejectedValueOnce(
      new NotAuthenticated('Tenant credential cannot be verified', {
        code: TENANT_RESTRICTED_ERROR_CODE,
      })
    );
    const context = await run();
    expect(context.result).toBe(session);
  });

  it('mints nothing and raises no 503 for a server-side no-token read, keeping its provider', async () => {
    generateSessionToken.mockClear();
    const params = withoutSessionMcpToken({
      user: { user_id: 'user-1', role: 'member' },
      provider: 'rest',
    });
    const context = await hook({ method: 'get', params, result: session } as never);
    expect(context.result).toBe(session);
    expect(generateSessionToken).not.toHaveBeenCalled();
    // Only the token hook is skipped: the caller's provider (and so its auth hooks) still applies.
    expect(params.provider).toBe('rest');
    expect(skipsSessionMcpToken(JSON.parse(JSON.stringify(params)))).toBe(false);
  });

  it('still surfaces minting failures that are not about tenant state', async () => {
    generateSessionToken.mockRejectedValueOnce(new Error('MCP token generation failed'));
    await expect(run()).rejects.toThrow('MCP token generation failed');
  });
});
