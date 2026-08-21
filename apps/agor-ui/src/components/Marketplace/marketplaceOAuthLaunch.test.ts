import type { MCPCatalogConnectResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeMarketplacePromptSuggestionState,
  saveMarketplacePromptSuggestion,
} from '../../utils/marketplaceOAuthPrompt';
import {
  launchMarketplaceOAuth,
  MarketplaceOAuthPopupNavigationError,
} from './marketplaceOAuthLaunch';

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
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('names only the authoritative saved server and stages a nonsecret prompt handoff', async () => {
    const { client, create } = clientWith({
      success: true,
      authorizationUrl: 'https://accounts.example.test/authorize',
      attempt_id: 'attempt-1',
    });
    const replace = vi.fn();
    const close = vi.fn();
    const popup = {
      operationId: 'popup-1',
      navigate: (url: string) => {
        replace(url);
        return true;
      },
      close,
    };
    await expect(
      launchMarketplaceOAuth(client, result, popup, {
        authority: { userId: 'alice', role: 'member', authGeneration: 3 },
        isCurrent: () => true,
      })
    ).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith({ mcp_server_id: 'server-oauth' });
    expect(replace).toHaveBeenCalledWith('https://accounts.example.test/authorize');
    expect(close).not.toHaveBeenCalled();
    expect(
      JSON.parse(sessionStorage.getItem('agor-marketplace-oauth-prompt:session-oauth')!)
    ).toMatchObject({
      sessionId: 'session-oauth',
      serverId: 'server-oauth',
      attemptId: 'attempt-1',
      prompt: 'Show my work',
      userId: 'alice',
      authGeneration: 3,
      popupOperationId: 'popup-1',
    });
  });

  it('fences an older suggestion when a newer OAuth attempt has no starter prompt', async () => {
    const authority = { userId: 'alice', role: 'member', authGeneration: 3 };
    const earlier = saveMarketplacePromptSuggestion({
      sessionId: result.session.session_id,
      attemptId: 'attempt-earlier',
      prompt: 'Old suggestion',
      authority,
    });
    const { client } = clientWith({
      success: true,
      authorizationUrl: 'https://accounts.example.test/authorize',
      attempt_id: 'attempt-newer',
    });
    const popup = {
      operationId: 'popup-newer',
      navigate: vi.fn(() => true),
      close: vi.fn(),
    };

    await expect(
      launchMarketplaceOAuth(client, { ...result, starter_prompt: undefined }, popup, {
        authority,
        isCurrent: () => true,
      })
    ).resolves.toBe(true);
    expect(earlier).not.toBeNull();
    expect(
      consumeMarketplacePromptSuggestionState(result.session.session_id, authority)
    ).toBeNull();
    expect(
      JSON.parse(
        sessionStorage.getItem(`agor-marketplace-oauth-prompt:${result.session.session_id}`)!
      )
    ).toMatchObject({ attemptId: 'attempt-newer', prompt: '' });
  });

  it('closes the pre-opened window when OAuth start is refused', async () => {
    const { client } = clientWith({ success: false, error: 'not available' });
    const close = vi.fn();
    const popup = { operationId: 'popup-2', navigate: vi.fn(), close };
    await expect(
      launchMarketplaceOAuth(client, result, popup, {
        authority: { userId: 'alice', role: 'member', authGeneration: 3 },
        isCurrent: () => true,
      })
    ).resolves.toBe(false);
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
      authority: { userId: 'alice', role: 'member', authGeneration: 3 },
      isCurrent: () => current,
    });
    current = false;
    release({
      success: true,
      authorizationUrl: 'https://accounts.example.test/authorize',
      attempt_id: 'attempt-stale',
    });
    await expect(launched).resolves.toBe(false);
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
          authority: { userId: 'alice', role: 'member', authGeneration: 3 },
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
