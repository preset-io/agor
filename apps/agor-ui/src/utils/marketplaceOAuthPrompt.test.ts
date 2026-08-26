import type { MCPOAuthAttemptResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimMarketplaceOAuthPrompt,
  consumeMarketplacePromptSuggestion,
  consumeMarketplacePromptSuggestionState,
  consumePendingMarketplaceOAuthPrompt,
  discardMarketplaceOAuthStateForAuthority,
  discardMarketplacePromptSuggestion,
  getMarketplacePromptStateRevision,
  isMarketplacePromptSuggestionCurrent,
  markMarketplacePromptAttempt,
  readPendingMarketplaceOAuthPrompt,
  saveMarketplacePromptSuggestion,
  savePendingMarketplaceOAuthPrompt,
  subscribeMarketplacePromptState,
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
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();

    savePendingMarketplaceOAuthPrompt(pending);
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
    ).resolves.toMatchObject({ prompt: pending.prompt, attemptId: pending.attemptId });
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

    savePromptDraft(authority.userId, pending.sessionId, 'Draft from another tab');
    resolveAttempt({
      attempt_id: pending.attemptId,
      mcp_server_id: pending.serverId,
      status: 'succeeded',
    } as MCPOAuthAttemptResult);
    const prompt = await claim;

    expect(prompt).toMatchObject({ prompt: pending.prompt, attemptId: pending.attemptId });
    const sharedDraftAtFinalBoundary = getPromptDraft(authority.userId, pending.sessionId);
    expect(getPromptDraft(authority.userId, pending.sessionId)).toBe('Draft from another tab');
    expect(getPromptDraft(authority.userId, pending.sessionId)).toBe(sharedDraftAtFinalBoundary);
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

  it('synchronously fences an earlier suggestion when a newer attempt begins', () => {
    const pending = value();
    saveMarketplacePromptSuggestion({
      sessionId: pending.sessionId,
      attemptId: pending.attemptId,
      prompt: pending.prompt,
      authority,
    });
    const earlier = consumeMarketplacePromptSuggestionState(pending.sessionId, authority);
    expect(earlier).not.toBeNull();
    // Re-save only for the render-state fence assertion after consuming the storage copy.
    saveMarketplacePromptSuggestion({
      sessionId: pending.sessionId,
      attemptId: pending.attemptId,
      prompt: pending.prompt,
      authority,
    });
    expect(isMarketplacePromptSuggestionCurrent(earlier!)).toBe(true);
    const revision = getMarketplacePromptStateRevision();
    const changed = vi.fn();
    const unsubscribe = subscribeMarketplacePromptState(changed);
    markMarketplacePromptAttempt({
      sessionId: pending.sessionId,
      attemptId: 'attempt-new',
      createdAt: Date.now(),
      ...authority,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(getMarketplacePromptStateRevision()).toBeGreaterThan(revision);
    expect(isMarketplacePromptSuggestionCurrent(earlier!)).toBe(false);
    expect(consumeMarketplacePromptSuggestionState(pending.sessionId, authority)).toBeNull();
    unsubscribe();
  });

  it('keeps a fully typed suggestion behind its memory fence when storage is unavailable', () => {
    const brokenStorage = storageContext();
    vi.spyOn(brokenStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('storage unavailable', 'SecurityError');
    });
    const suggestion = saveMarketplacePromptSuggestion(
      {
        sessionId: 'session-storage-failure',
        attemptId: 'attempt-storage-failure',
        prompt: 'Try safely',
        authority,
      },
      brokenStorage
    );

    expect(suggestion).toEqual(
      expect.objectContaining({
        sessionId: 'session-storage-failure',
        attemptId: 'attempt-storage-failure',
        prompt: 'Try safely',
        ...authority,
        createdAt: expect.any(Number),
      })
    );
    expect(isMarketplacePromptSuggestionCurrent(suggestion!, brokenStorage)).toBe(true);
    const unavailableStorage = {
      get length(): number {
        throw new DOMException('storage unavailable', 'SecurityError');
      },
      clear: vi.fn(),
      getItem: vi.fn(),
      key: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    } as unknown as Storage;
    expect(() =>
      discardMarketplaceOAuthStateForAuthority(authority, unavailableStorage)
    ).not.toThrow();
  });

  it.each(['quota', 'read-only'] as const)(
    'fences readable old storage before a newer %s marker write can fail',
    (failureMode) => {
      const storage = storageContext();
      const old = {
        sessionId: 'session-quota',
        attemptId: 'attempt-old',
        prompt: 'Old suggestion',
        createdAt: Date.now(),
        ...authority,
      };
      const otherSession = {
        ...old,
        sessionId: 'session-isolated',
        attemptId: 'attempt-isolated',
        prompt: 'Other suggestion',
      };
      // Seed as if this module realm was loaded after a page reload: there is
      // readable durable state but no memory marker yet.
      storage.setItem(`agor-marketplace-prompt-attempt:${old.sessionId}`, JSON.stringify(old));
      storage.setItem(`agor-marketplace-prompt-suggestion:${old.sessionId}`, JSON.stringify(old));
      storage.setItem(
        `agor-marketplace-prompt-attempt:${otherSession.sessionId}`,
        JSON.stringify(otherSession)
      );
      storage.setItem(
        `agor-marketplace-prompt-suggestion:${otherSession.sessionId}`,
        JSON.stringify(otherSession)
      );
      expect(isMarketplacePromptSuggestionCurrent(old, storage)).toBe(true);
      expect(isMarketplacePromptSuggestionCurrent(otherSession, storage)).toBe(true);

      const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      });
      const removeItem =
        failureMode === 'read-only'
          ? vi.spyOn(storage, 'removeItem').mockImplementation(() => {
              throw new DOMException('storage is read-only', 'SecurityError');
            })
          : null;
      markMarketplacePromptAttempt(
        {
          sessionId: old.sessionId,
          attemptId: 'attempt-new-failed-write',
          createdAt: Date.now(),
          ...authority,
        },
        storage
      );

      // The old marker was readable immediately before the failed write. The
      // memory authority still closes both render and action gates synchronously.
      expect(isMarketplacePromptSuggestionCurrent(old, storage)).toBe(false);
      expect(isMarketplacePromptSuggestionCurrent(otherSession, storage)).toBe(true);

      setItem.mockRestore();
      removeItem?.mockRestore();
      markMarketplacePromptAttempt(
        {
          sessionId: old.sessionId,
          attemptId: 'attempt-new-persisted',
          createdAt: Date.now(),
          ...authority,
        },
        storage
      );
      const current = saveMarketplacePromptSuggestion(
        {
          sessionId: old.sessionId,
          attemptId: 'attempt-new-persisted',
          prompt: 'Current suggestion',
          authority,
        },
        storage
      )!;
      expect(isMarketplacePromptSuggestionCurrent(old, storage)).toBe(false);
      expect(isMarketplacePromptSuggestionCurrent(current, storage)).toBe(true);
      expect(isMarketplacePromptSuggestionCurrent(otherSession, storage)).toBe(true);
    }
  );

  it('keeps memory fences and held claims authoritative across module replacement', async () => {
    const storage = storageContext();
    const pending = {
      ...value(),
      sessionId: 'session-hmr',
      attemptId: 'attempt-hmr-old',
    };
    const oldSuggestion = saveMarketplacePromptSuggestion(
      {
        sessionId: pending.sessionId,
        attemptId: pending.attemptId,
        prompt: pending.prompt,
        authority,
      },
      storage
    )!;
    savePendingMarketplaceOAuthPrompt(pending, storage);
    let rejectAttempt!: (error: Error) => void;
    const held = new Promise<never>((_, reject) => {
      rejectAttempt = reject;
    });
    const oldClaim = claimMarketplaceOAuthPrompt({
      client: { service: () => ({ get: () => held }) } as unknown as AgorClient,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set(),
      authority,
      isCurrent: () => true,
      storage,
    });

    vi.resetModules();
    const replacement = await import('./marketplaceOAuthPrompt');
    const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('read-only after HMR', 'SecurityError');
    });
    const removeItem = vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new DOMException('read-only after HMR', 'SecurityError');
    });
    replacement.markMarketplacePromptAttempt(
      {
        sessionId: pending.sessionId,
        attemptId: 'attempt-hmr-new',
        createdAt: Date.now(),
        ...authority,
      },
      storage
    );
    expect(isMarketplacePromptSuggestionCurrent(oldSuggestion, storage)).toBe(false);
    setItem.mockRestore();
    removeItem.mockRestore();

    replacement.discardMarketplaceOAuthStateForAuthority(authority, storage);
    rejectAttempt(new Error('transient result from replaced module'));
    await expect(oldClaim).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId, storage)).toBeNull();
  });

  it('expires an in-memory suggestion through its exact attempt marker', () => {
    const pending = value();
    const suggestion = saveMarketplacePromptSuggestion({
      sessionId: pending.sessionId,
      attemptId: pending.attemptId,
      prompt: pending.prompt,
      authority,
    });
    savePendingMarketplaceOAuthPrompt({
      ...pending,
      createdAt: Date.now() - 2 * 60 * 60 * 1000,
    });

    expect(isMarketplacePromptSuggestionCurrent(suggestion!)).toBe(false);
    expect(consumeMarketplacePromptSuggestionState(pending.sessionId, authority)).toBeNull();
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
    await expect(initiatingClaim).resolves.toMatchObject({ prompt: pending.prompt });
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
    expect(results.filter(Boolean)).toEqual([
      expect.objectContaining({ prompt: pending.prompt, attemptId: pending.attemptId }),
    ]);
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
    await expect(replacementEffect).resolves.toMatchObject({ prompt: pending.prompt });
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

  it('never restores succeeded handoff when its only claimant unmounts', async () => {
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
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
    expect(consumeMarketplacePromptSuggestion(pending.sessionId, authority)).toBeNull();
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

    let effectCurrent = true;
    const heldClient = {
      service: () => ({
        get: vi.fn(async () => {
          effectCurrent = false;
          throw new Error('identity changed');
        }),
      }),
    } as unknown as AgorClient;
    await claimMarketplaceOAuthPrompt({
      client: heldClient,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set([pending.serverId]),
      authority,
      isCurrent: () => effectCurrent,
      isAuthorityCurrent: () => true,
    });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toEqual(pending);
  });

  it('never restores a nonterminal result after exact authority becomes obsolete', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    let authorityCurrent = true;
    let effectCurrent = true;
    await claimMarketplaceOAuthPrompt({
      client: {
        service: () => ({
          get: vi.fn(async () => {
            authorityCurrent = false;
            effectCurrent = false;
            return { status: 'pending', mcp_server_id: pending.serverId };
          }),
        }),
      } as unknown as AgorClient,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set(),
      authority,
      isCurrent: () => effectCurrent,
      isAuthorityCurrent: () => authorityCurrent,
    });
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
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

  it('central logout clears only its authority and prevents held transient restoration', async () => {
    const pending = value();
    savePendingMarketplaceOAuthPrompt(pending);
    let current = true;
    let rejectAttempt!: (error: Error) => void;
    const held = new Promise<never>((_, reject) => (rejectAttempt = reject));
    const claim = claimMarketplaceOAuthPrompt({
      client: { service: () => ({ get: () => held }) } as unknown as AgorClient,
      sessionId: pending.sessionId,
      authenticatedServerIds: new Set(),
      authority,
      isCurrent: () => current,
    });
    const bob = { ...pending, sessionId: 'session-bob', userId: 'bob' };
    savePendingMarketplaceOAuthPrompt(bob);

    current = false;
    discardMarketplaceOAuthStateForAuthority(authority);
    rejectAttempt(new Error('offline'));
    await expect(claim).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(bob.sessionId)).toEqual(bob);
  });

  it.each(['failed', 'cancelled', 'ambiguous', 'expired', 'not_found', 'unknown'])(
    'lets terminal %s permanently clean even when the claimant is stale',
    async (status) => {
      const pending = value();
      savePendingMarketplaceOAuthPrompt(pending);
      let current = true;
      const claim = claimMarketplaceOAuthPrompt({
        client: clientWith({
          attempt_id: pending.attemptId,
          mcp_server_id: pending.serverId,
          status,
        }),
        sessionId: pending.sessionId,
        authenticatedServerIds: new Set(),
        authority,
        isCurrent: () => current,
      });
      current = false;
      await expect(claim).resolves.toBeNull();
      expect(readPendingMarketplaceOAuthPrompt(pending.sessionId)).toBeNull();
    }
  );

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
        status: 'succeeded',
        mcp_server_id: 'wrong-server',
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
