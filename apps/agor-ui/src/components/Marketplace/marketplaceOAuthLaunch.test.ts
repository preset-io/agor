import type { MCPCatalogConnectResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchMarketplaceOAuth } from './marketplaceOAuthLaunch';

const result = {
  mcp_server: { mcp_server_id: 'server-oauth', auth: { type: 'oauth' } },
  session: { session_id: 'session-oauth' },
  starter_prompt: 'Show my work',
} as MCPCatalogConnectResult;

function clientWith(answer: unknown) {
  const create = vi.fn(async () => answer);
  return {
    client: { service: () => ({ create }) } as unknown as AgorClient,
    create,
  };
}

describe('Marketplace OAuth launch', () => {
  beforeEach(() => localStorage.clear());

  it('names only the authoritative saved server and stages a nonsecret prompt handoff', async () => {
    const { client, create } = clientWith({
      success: true,
      authorizationUrl: 'https://accounts.example.test/authorize',
      attempt_id: 'attempt-1',
    });
    const replace = vi.fn();
    const close = vi.fn();
    const popup = { location: { replace }, close } as unknown as Window;
    await expect(launchMarketplaceOAuth(client, result, popup)).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith({ mcp_server_id: 'server-oauth' });
    expect(replace).toHaveBeenCalledWith('https://accounts.example.test/authorize');
    expect(close).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem('agor-marketplace-oauth-prompt:session-oauth')!)
    ).toMatchObject({
      sessionId: 'session-oauth',
      serverId: 'server-oauth',
      attemptId: 'attempt-1',
      prompt: 'Show my work',
    });
  });

  it('closes the pre-opened window when OAuth start is refused', async () => {
    const { client } = clientWith({ success: false, error: 'not available' });
    const close = vi.fn();
    const popup = { location: { replace: vi.fn() }, close } as unknown as Window;
    await expect(launchMarketplaceOAuth(client, result, popup)).resolves.toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(localStorage.getItem('agor-marketplace-oauth-prompt:session-oauth')).toBeNull();
  });
});
