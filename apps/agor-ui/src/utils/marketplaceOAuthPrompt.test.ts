import type { AgorClient } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimMarketplaceOAuthPrompt,
  consumePendingMarketplaceOAuthPrompt,
  readPendingMarketplaceOAuthPrompt,
  savePendingMarketplaceOAuthPrompt,
} from './marketplaceOAuthPrompt';

const authority = { userId: 'alice', role: 'member', authGeneration: 7 };
const value = () => ({
  sessionId: 'session-1',
  serverId: 'server-1',
  attemptId: 'attempt-1',
  popupOperationId: 'popup-1',
  prompt: 'Try the server',
  createdAt: Date.now(),
  ...authority,
});

const clientWith = (answer: unknown) =>
  ({
    service: () => ({ get: vi.fn(async () => answer) }),
  }) as unknown as AgorClient;

describe('Marketplace OAuth prompt handoff', () => {
  beforeEach(() => localStorage.clear());

  it('stores only nonsecret authority/routing metadata and consumes by exact attempt once', () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toEqual(pending);
    expect(consumePendingMarketplaceOAuthPrompt(pending.sessionId, 'another-attempt')).toBeNull();
    expect(consumePendingMarketplaceOAuthPrompt(pending.sessionId, pending.attemptId)).toEqual(
      pending
    );
    expect(consumePendingMarketplaceOAuthPrompt(pending.sessionId, pending.attemptId)).toBeNull();
    expect(JSON.stringify(localStorage)).not.toMatch(
      /access.token|refresh.token|secret|issuer|resource/i
    );
  });

  it('requires durable authentication and this exact succeeded attempt', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    await expect(
      claimMarketplaceOAuthPrompt({
        client: clientWith({ status: 'succeeded', mcp_server_id: pending.serverId }),
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set(),
        authority,
        isCurrent: () => true,
      })
    ).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).not.toBeNull();

    await expect(
      claimMarketplaceOAuthPrompt({
        client: clientWith({ status: 'succeeded', mcp_server_id: pending.serverId }),
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set([pending.serverId]),
        authority,
        isCurrent: () => true,
      })
    ).resolves.toBe(pending.prompt);
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
  });

  it('removes cancelled, stale, or wrong-authority handoffs', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    await claimMarketplaceOAuthPrompt({
      client: clientWith({ status: 'failed', mcp_server_id: pending.serverId }),
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set(),
      authority,
      isCurrent: () => true,
    });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();

    savePendingMarketplaceOAuthPrompt({ ...pending, createdAt: Date.now() - 2 * 60 * 60 * 1000 });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();

    savePendingMarketplaceOAuthPrompt(pending);
    await claimMarketplaceOAuthPrompt({
      client: clientWith({ status: 'succeeded', mcp_server_id: pending.serverId }),
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority: { ...authority, userId: 'bob' },
      isCurrent: () => true,
    });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();

    savePendingMarketplaceOAuthPrompt(pending);
    const missingClient = {
      service: () => ({
        get: vi.fn(async () => {
          throw Object.assign(new Error('missing'), { code: 404, name: 'NotFound' });
        }),
      }),
    } as unknown as AgorClient;
    await claimMarketplaceOAuthPrompt({
      client: missingClient,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => true,
    });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
  });
});
