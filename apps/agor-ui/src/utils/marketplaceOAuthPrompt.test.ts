import type { MCPOAuthAttemptResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimMarketplaceOAuthPrompt,
  consumeMarketplacePromptSuggestion,
  consumePendingMarketplaceOAuthPrompt,
  discardMarketplacePromptSuggestion,
  readPendingMarketplaceOAuthPrompt,
  saveMarketplacePromptSuggestion,
  savePendingMarketplaceOAuthPrompt,
} from './marketplaceOAuthPrompt';
import { getPromptDraft, savePromptDraft } from './promptDrafts';

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

function storageContext(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('Marketplace OAuth prompt handoff', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('stores only nonsecret authority/routing metadata and consumes by exact attempt once', () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toEqual(pending);
    expect(consumePendingMarketplaceOAuthPrompt(pending.sessionId, 'another-attempt')).toBeNull();
    expect(consumePendingMarketplaceOAuthPrompt(pending.sessionId, pending.attemptId)).toEqual(
      pending
    );
    expect(consumePendingMarketplaceOAuthPrompt(pending.sessionId, pending.attemptId)).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toMatch(
      /access.token|refresh.token|secret|issuer|resource/i
    );
    expect(localStorage.length).toBe(0);
  });

  it('requires durable authentication and this exact succeeded attempt', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    await expect(
      claimMarketplaceOAuthPrompt({
        client: clientWith({
          attempt_id: pending.attemptId,
          status: 'succeeded',
          mcp_server_id: pending.serverId,
        }),
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set(),
        authority,
        isCurrent: () => true,
      })
    ).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).not.toBeNull();

    await expect(
      claimMarketplaceOAuthPrompt({
        client: clientWith({
          attempt_id: pending.attemptId,
          status: 'succeeded',
          mcp_server_id: pending.serverId,
        }),
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set([pending.serverId]),
        authority,
        isCurrent: () => true,
      })
    ).resolves.toBe(pending.prompt);
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
  });

  it("never enters the shared draft keyspace when another tab writes during OAuth's final await", async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    let resolveAttempt!: (value: MCPOAuthAttemptResult) => void;
    const held = new Promise<MCPOAuthAttemptResult>((resolve) => (resolveAttempt = resolve));
    const client = {
      service: () => ({ get: vi.fn(() => held) }),
    } as unknown as AgorClient;
    const claim = claimMarketplaceOAuthPrompt({
      client,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => true,
    });

    savePromptDraft(pending.sessionId, 'Draft from another tab');
    resolveAttempt({
      attempt_id: pending.attemptId,
      mcp_server_id: pending.serverId,
      status: 'succeeded',
    } as MCPOAuthAttemptResult);
    const prompt = await claim;

    expect(prompt).toBe(pending.prompt);
    const sharedDraftAtFinalBoundary = getPromptDraft(pending.sessionId);
    expect(getPromptDraft(pending.sessionId)).toBe('Draft from another tab');
    expect(getPromptDraft(pending.sessionId)).toBe(sharedDraftAtFinalBoundary);
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority)).toBe(pending.prompt);
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority)).toBeNull();
  });

  it('keeps the suggestion tab-local, authority-scoped, and dismissible', () => {
    const pending = value();
    saveMarketplacePromptSuggestion({
      sessionId: pending.sessionId,
      prompt: pending.prompt,
      authority,
    });
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority)).toBe(pending.prompt);
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority)).toBeNull();
    saveMarketplacePromptSuggestion({
      sessionId: pending.sessionId,
      prompt: pending.prompt,
      authority,
    });
    expect(
      consumeMarketplacePromptSuggestion(pending.sessionId, { ...authority, userId: 'bob' })
    ).toBeNull();

    saveMarketplacePromptSuggestion({
      sessionId: pending.sessionId,
      prompt: pending.prompt,
      authority,
    });
    discardMarketplacePromptSuggestion(pending.sessionId);
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority)).toBeNull();
  });

  it('keeps both handoff and suggestion invisible to another tab storage context', () => {
    const initiatingTab = storageContext();
    const otherTab = storageContext();
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending, initiatingTab);
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId, initiatingTab)).toEqual(pending);
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId, otherTab)).toBeNull();

    saveMarketplacePromptSuggestion(
      { sessionId: pending.sessionId, prompt: pending.prompt, authority },
      initiatingTab
    );
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority, otherTab)).toBeNull();
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority, initiatingTab)).toBe(
      pending.prompt
    );
  });

  it('does not expose an in-flight claim to another tab storage context', async () => {
    const initiatingTab = storageContext();
    const otherTab = storageContext();
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending, initiatingTab);
    let resolveAttempt!: (value: MCPOAuthAttemptResult) => void;
    const held = new Promise<MCPOAuthAttemptResult>((resolve) => (resolveAttempt = resolve));
    const get = vi.fn(() => held);
    const client = { service: () => ({ get }) } as unknown as AgorClient;
    const initiatingClaim = claimMarketplaceOAuthPrompt({
      client,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => true,
      storage: initiatingTab,
    });

    await expect(
      claimMarketplaceOAuthPrompt({
        client,
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set([pending.serverId]),
        authority,
        isCurrent: () => true,
        storage: otherTab,
      })
    ).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    resolveAttempt({
      attempt_id: pending.attemptId,
      mcp_server_id: pending.serverId,
      status: 'succeeded',
    } as MCPOAuthAttemptResult);
    await expect(initiatingClaim).resolves.toBe(pending.prompt);
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority, otherTab)).toBeNull();
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority, initiatingTab)).toBe(
      pending.prompt
    );
  });

  it('joins concurrent consumers in one tab and yields the prompt exactly once', async () => {
    const initiatingTab = storageContext();
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending, initiatingTab);
    let resolveAttempt!: (value: MCPOAuthAttemptResult) => void;
    const held = new Promise<MCPOAuthAttemptResult>((resolve) => (resolveAttempt = resolve));
    const get = vi.fn(() => held);
    const client = {
      service: () => ({ get }),
    } as unknown as AgorClient;
    const input = {
      client,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => true,
      storage: initiatingTab,
    };

    const first = claimMarketplaceOAuthPrompt(input);
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId, initiatingTab)).toBeNull();
    const second = claimMarketplaceOAuthPrompt(input);
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(1);
    resolveAttempt({
      attempt_id: pending.attemptId,
      mcp_server_id: pending.serverId,
      status: 'succeeded',
    } as MCPOAuthAttemptResult);
    const results = await Promise.all([first, second]);
    expect(results.filter(Boolean)).toEqual([pending.prompt]);
    await expect(claimMarketplaceOAuthPrompt(input)).resolves.toBeNull();
  });

  it('lets a replacement effect adopt a held claim after the old effect is cancelled', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    let resolveAttempt!: (value: MCPOAuthAttemptResult) => void;
    const held = new Promise<MCPOAuthAttemptResult>((resolve) => (resolveAttempt = resolve));
    const get = vi.fn(() => held);
    const client = { service: () => ({ get }) } as unknown as AgorClient;
    let oldCurrent = true;
    const oldEffect = claimMarketplaceOAuthPrompt({
      client,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => oldCurrent,
    });
    oldCurrent = false;
    const replacementEffect = claimMarketplaceOAuthPrompt({
      client,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => true,
    });

    resolveAttempt({
      attempt_id: pending.attemptId,
      mcp_server_id: pending.serverId,
      status: 'succeeded',
    } as MCPOAuthAttemptResult);
    await expect(oldEffect).resolves.toBeNull();
    await expect(replacementEffect).resolves.toBe(pending.prompt);
    expect(get).toHaveBeenCalledTimes(1);
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority)).toBe(pending.prompt);
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority)).toBeNull();
    await expect(
      claimMarketplaceOAuthPrompt({
        client,
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set([pending.serverId]),
        authority,
        isCurrent: () => true,
      })
    ).resolves.toBeNull();
  });

  it('restores a held claim for remount when its only effect is cancelled', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    let resolveAttempt!: (value: MCPOAuthAttemptResult) => void;
    const held = new Promise<MCPOAuthAttemptResult>((resolve) => (resolveAttempt = resolve));
    let mounted = true;
    const oldEffect = claimMarketplaceOAuthPrompt({
      client: { service: () => ({ get: () => held }) } as unknown as AgorClient,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => mounted,
    });
    mounted = false;
    resolveAttempt({
      attempt_id: pending.attemptId,
      mcp_server_id: pending.serverId,
      status: 'succeeded',
    } as MCPOAuthAttemptResult);
    await expect(oldEffect).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toEqual(pending);

    await expect(
      claimMarketplaceOAuthPrompt({
        client: clientWith({
          attempt_id: pending.attemptId,
          mcp_server_id: pending.serverId,
          status: 'succeeded',
        }),
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set([pending.serverId]),
        authority,
        isCurrent: () => true,
      })
    ).resolves.toBe(pending.prompt);
  });

  it('restores a transiently unreadable exact attempt across effect replacement', async () => {
    const pending = value();
    const transientClient = {
      service: () => ({
        get: vi.fn(() => {
          throw new Error('temporarily offline');
        }),
      }),
    } as unknown as AgorClient;
    savePendingMarketplaceOAuthPrompt(pending);
    await expect(
      claimMarketplaceOAuthPrompt({
        client: transientClient,
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set([pending.serverId]),
        authority,
        isCurrent: () => true,
      })
    ).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toEqual(pending);

    let current = true;
    const heldClient = {
      service: () => ({
        get: vi.fn(async () => {
          current = false;
          throw new Error('identity changed');
        }),
      }),
    } as unknown as AgorClient;
    await claimMarketplaceOAuthPrompt({
      client: heldClient,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => current,
    });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toEqual(pending);
  });

  it('cleans a held claim when identity authority is replaced', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    let resolveAttempt!: (value: MCPOAuthAttemptResult) => void;
    const held = new Promise<MCPOAuthAttemptResult>((resolve) => (resolveAttempt = resolve));
    let aliceCurrent = true;
    const alice = claimMarketplaceOAuthPrompt({
      client: { service: () => ({ get: () => held }) } as unknown as AgorClient,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => aliceCurrent,
    });
    aliceCurrent = false;
    await expect(
      claimMarketplaceOAuthPrompt({
        client: clientWith({
          attempt_id: pending.attemptId,
          mcp_server_id: pending.serverId,
          status: 'succeeded',
        }),
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set([pending.serverId]),
        authority: { ...authority, userId: 'bob', authGeneration: 8 },
        isCurrent: () => true,
      })
    ).resolves.toBeNull();
    resolveAttempt({
      attempt_id: pending.attemptId,
      mcp_server_id: pending.serverId,
      status: 'succeeded',
    } as MCPOAuthAttemptResult);
    await expect(alice).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
  });

  it('removes cancelled, stale, or wrong-authority handoffs', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    await claimMarketplaceOAuthPrompt({
      client: clientWith({
        attempt_id: pending.attemptId,
        status: 'failed',
        mcp_server_id: pending.serverId,
      }),
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set(),
      authority,
      isCurrent: () => true,
    });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();

    savePendingMarketplaceOAuthPrompt(pending);
    await claimMarketplaceOAuthPrompt({
      client: clientWith({
        attempt_id: 'unrelated-later-attempt',
        status: 'succeeded',
        mcp_server_id: pending.serverId,
      }),
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => true,
    });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();

    savePendingMarketplaceOAuthPrompt({ ...pending, createdAt: Date.now() - 2 * 60 * 60 * 1000 });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();

    savePendingMarketplaceOAuthPrompt(pending);
    await claimMarketplaceOAuthPrompt({
      client: clientWith({
        attempt_id: pending.attemptId,
        status: 'succeeded',
        mcp_server_id: pending.serverId,
      }),
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
