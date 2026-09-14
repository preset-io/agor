import type { MCPCatalogConnectResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import {
  launchMarketplaceOAuth,
  MarketplaceOAuthPopupNavigationError,
} from './marketplaceOAuthLaunch';

const result = {
  mcp_server: { mcp_server_id: 'server-oauth', auth: { type: 'oauth' } },
  starter_prompt: 'Show my work',
} as MCPCatalogConnectResult;

function clientWith(answer: unknown) {
  const create = vi.fn(async () => answer);
  return { client: { service: () => ({ create }) } as unknown as AgorClient, create };
}

describe('MCP Catalog OAuth launch', () => {
  it('starts auth for only the persisted server and does not stage composer UI', async () => {
    const { client, create } = clientWith({
      success: true,
      authorizationUrl: 'https://accounts.example.test/authorize',
      attempt_id: 'attempt-1',
    });
    const popup = { operationId: 'popup-1', navigate: vi.fn(() => true), close: vi.fn() };

    await expect(
      launchMarketplaceOAuth(client, result, popup, { isCurrent: () => true })
    ).resolves.toEqual({ attemptId: 'attempt-1' });
    expect(create).toHaveBeenCalledWith({ mcp_server_id: 'server-oauth' });
    expect(popup.navigate).toHaveBeenCalledWith(
      'https://accounts.example.test/authorize',
      expect.any(Function)
    );
    expect(sessionStorage.length).toBe(0);
  });

  it('closes a reserved popup when auth start is refused or authority changes', async () => {
    const refused = clientWith({ success: false, error: 'not available' });
    const popup = { operationId: 'popup-2', navigate: vi.fn(), close: vi.fn() };
    await expect(
      launchMarketplaceOAuth(refused.client, result, popup, { isCurrent: () => true })
    ).rejects.toThrow('not available');
    expect(popup.close).toHaveBeenCalledOnce();

    const current = false;
    const stalePopup = { operationId: 'popup-3', navigate: vi.fn(), close: vi.fn() };
    await expect(
      launchMarketplaceOAuth(clientWith({}).client, result, stalePopup, {
        isCurrent: () => current,
      })
    ).resolves.toBeNull();
    expect(stalePopup.close).toHaveBeenCalledOnce();
  });

  it('keeps the durable server/auth attempt recoverable when popup navigation fails', async () => {
    const { client } = clientWith({
      success: true,
      authorizationUrl: 'https://accounts.example.test/authorize',
      attempt_id: 'attempt-1',
    });
    const popup = { operationId: 'popup-4', navigate: vi.fn(() => false), close: vi.fn() };
    await expect(
      launchMarketplaceOAuth(client, result, popup, { isCurrent: () => true })
    ).rejects.toBeInstanceOf(MarketplaceOAuthPopupNavigationError);
    expect(popup.close).toHaveBeenCalledOnce();
  });
});
