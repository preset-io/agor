import type { MCPCatalogConnectResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  launchMarketplaceOAuth,
  MarketplaceOAuthPopupNavigationError,
  MarketplaceOAuthStartError,
} from './marketplaceOAuthLaunch';

const result = {
  mcp_server: { mcp_server_id: 'server-oauth', auth: { type: 'oauth' } },
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
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('closes the pre-opened window and preserves the safe recovery when OAuth start is refused', async () => {
    const { client } = clientWith({
      success: false,
      error: 'The provider does not support automatic client registration.',
    });
    const close = vi.fn();
    const popup = { operationId: 'popup-2', navigate: vi.fn(), close };
    await expect(
      launchMarketplaceOAuth(client, result, popup, {
        isCurrent: () => true,
      })
    ).rejects.toEqual(
      new MarketplaceOAuthStartError('The provider does not support automatic client registration.')
    );
    expect(close).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('agor-marketplace-oauth-prompt:session-oauth')).toBeNull();
  });

  it('closes without handoff or navigation when authority changes during oauth-start', async () => {
    let release!: (value: unknown) => void;
    const held = new Promise((resolve) => (release = resolve));
    const { client } = clientWith(held);
    let current = true;
    const popup = { operationId: 'popup-stale', navigate: vi.fn(), close: vi.fn() };
    const launched = launchMarketplaceOAuth(client, result, popup, {
      isCurrent: () => current,
    });
    current = false;
    release({
      success: true,
      authorizationUrl: 'https://accounts.example.test/authorize',
      attempt_id: 'attempt-stale',
    });
    await expect(launched).resolves.toBeNull();
    expect(popup.close).toHaveBeenCalledOnce();
    expect(popup.navigate).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it.each(['closed', 'replace-throw'] as const)(
    'discards the exact handoff and closes when popup navigation is %s',
    async (failure) => {
      const { client } = clientWith({
        success: true,
        authorizationUrl: 'https://accounts.example.test/authorize',
        attempt_id: `attempt-${failure}`,
      });
      const close = vi.fn();
      const popup = {
        operationId: `popup-${failure}`,
        close,
        navigate: vi.fn(() => {
          if (failure === 'replace-throw') throw new Error('WindowProxy navigation failed');
          return false;
        }),
      };

      await expect(
        launchMarketplaceOAuth(client, result, popup, {
          isCurrent: () => true,
        })
      ).rejects.toBeInstanceOf(MarketplaceOAuthPopupNavigationError);
      expect(close).toHaveBeenCalledOnce();
      expect(sessionStorage.getItem('agor-marketplace-oauth-prompt:session-oauth')).toBeNull();
      // No cancellation call is made: the durable attempt remains recoverable
      // from the already-created session.
      expect(client.service('mcp-servers/oauth-start')).toBeDefined();
    }
  );
});
