import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumePendingMarketplaceOAuthPrompt,
  readPendingMarketplaceOAuthPrompt,
  savePendingMarketplaceOAuthPrompt,
  takeMarketplaceOAuthPrompt,
} from './marketplaceOAuthPrompt';

describe('Marketplace OAuth prompt handoff', () => {
  beforeEach(() => localStorage.clear());

  it('stores only nonsecret prompt routing metadata and consumes exactly once', () => {
    const value = {
      sessionId: 'session-1',
      serverId: 'server-1',
      attemptId: 'attempt-1',
      prompt: 'Try the server',
      createdAt: Date.now(),
    };
    savePendingMarketplaceOAuthPrompt(value);
    expect(readPendingMarketplaceOAuthPrompt(value.sessionId)).toEqual(value);
    expect(consumePendingMarketplaceOAuthPrompt(value.sessionId)).toEqual(value);
    expect(consumePendingMarketplaceOAuthPrompt(value.sessionId)).toBeNull();
    expect(JSON.stringify(localStorage)).not.toMatch(/token|secret|client|issuer|resource/i);
  });

  it('waits for durable authentication and never overwrites user text', () => {
    const value = {
      sessionId: 'session-1',
      serverId: 'server-1',
      attemptId: 'attempt-1',
      prompt: 'Try the server',
      createdAt: Date.now(),
    };
    savePendingMarketplaceOAuthPrompt(value);
    expect(takeMarketplaceOAuthPrompt(value.sessionId, new Set(), '')).toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(value.sessionId)).not.toBeNull();
    expect(
      takeMarketplaceOAuthPrompt(value.sessionId, new Set(['server-1']), 'my own text')
    ).toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(value.sessionId)).toBeNull();

    savePendingMarketplaceOAuthPrompt(value);
    expect(takeMarketplaceOAuthPrompt(value.sessionId, new Set(['server-1']), '')).toBe(
      'Try the server'
    );
    expect(takeMarketplaceOAuthPrompt(value.sessionId, new Set(['server-1']), '')).toBeNull();
  });
});
