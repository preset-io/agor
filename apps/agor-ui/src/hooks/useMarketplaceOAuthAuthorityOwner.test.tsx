import type { MCPOAuthAttemptResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimMarketplaceOAuthPrompt,
  consumeMarketplacePromptSuggestion,
  isMarketplacePromptSuggestionCurrent,
  readPendingMarketplaceOAuthPrompt,
  saveMarketplacePromptSuggestion,
  savePendingMarketplaceOAuthPrompt,
} from '../utils/marketplaceOAuthPrompt';
import { useMarketplaceOAuthAuthorityOwner } from './useMarketplaceOAuthAuthorityOwner';

const identity = { user_id: 'alice', role: 'member' } as const;
const gen7 = { userId: identity.user_id, role: identity.role, authGeneration: 7 };
const gen8 = { ...gen7, authGeneration: 8 };

describe('useMarketplaceOAuthAuthorityOwner', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('cleans a held old generation before publishing the new generation without a panel', async () => {
    const { result, rerender } = renderHook(({ user }) => useMarketplaceOAuthAuthorityOwner(user), {
      initialProps: { user: identity },
    });
    act(() => {
      result.current.beforeAuthGenerationChange(6, 7);
      result.current.observeRenderedGeneration(7);
    });

    const oldSuggestion = saveMarketplacePromptSuggestion({
      sessionId: 'session-suggestion-gen7',
      attemptId: 'attempt-suggestion-gen7',
      prompt: 'Old generation suggestion',
      authority: gen7,
    })!;
    const oldPending = {
      sessionId: 'session-held-gen7',
      serverId: 'server-held-gen7',
      attemptId: 'attempt-held-gen7',
      popupOperationId: 'popup-held-gen7',
      prompt: 'Old generation prompt',
      createdAt: Date.now(),
      ...gen7,
    };
    savePendingMarketplaceOAuthPrompt(oldPending);
    const idleOldPending = {
      ...oldPending,
      sessionId: 'session-idle-gen7',
      attemptId: 'attempt-idle-gen7',
      popupOperationId: 'popup-idle-gen7',
    };
    savePendingMarketplaceOAuthPrompt(idleOldPending);
    let rejectOldAttempt!: (error: Error) => void;
    const heldOldAttempt = new Promise<never>((_, reject) => {
      rejectOldAttempt = reject;
    });
    const oldClaim = claimMarketplaceOAuthPrompt({
      client: {
        service: () => ({ get: () => heldOldAttempt }),
      } as unknown as AgorClient,
      sessionId: oldPending.sessionId,
      authenticatedServerIds: new Set(),
      authority: gen7,
      isCurrent: () => true,
      isAuthorityCurrent: () => true,
    });

    // A normal parent render with the same generation does not run cleanup.
    rerender({ user: { ...identity } });
    expect(isMarketplacePromptSuggestionCurrent(oldSuggestion)).toBe(true);

    // This callback is invoked by the connection owner before setState(8).
    act(() => result.current.beforeAuthGenerationChange(7, 8));
    result.current.observeRenderedGeneration(8);
    expect(isMarketplacePromptSuggestionCurrent(oldSuggestion)).toBe(false);
    expect(readPendingMarketplaceOAuthPrompt(oldPending.sessionId)).toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(idleOldPending.sessionId)).toBeNull();
    rejectOldAttempt(new Error('transient after generation replacement'));
    await expect(oldClaim).resolves.toBeNull();
    expect(readPendingMarketplaceOAuthPrompt(oldPending.sessionId)).toBeNull();

    const currentPending = {
      ...oldPending,
      sessionId: 'session-gen8',
      serverId: 'server-gen8',
      attemptId: 'attempt-gen8',
      popupOperationId: 'popup-gen8',
      prompt: 'Current generation prompt',
      ...gen8,
    };
    savePendingMarketplaceOAuthPrompt(currentPending);
    await expect(
      claimMarketplaceOAuthPrompt({
        client: {
          service: () => ({
            get: async () =>
              ({
                attempt_id: currentPending.attemptId,
                status: 'succeeded',
                mcp_server_id: currentPending.serverId,
              }) satisfies MCPOAuthAttemptResult,
          }),
        } as unknown as AgorClient,
        sessionId: currentPending.sessionId,
        authenticatedServerIds: new Set([currentPending.serverId]),
        authority: gen8,
        isCurrent: () => true,
        isAuthorityCurrent: () => true,
      })
    ).resolves.toMatchObject({
      attemptId: currentPending.attemptId,
      prompt: currentPending.prompt,
      ...gen8,
    });
    expect(consumeMarketplacePromptSuggestion(currentPending.sessionId, gen8)).toBe(
      currentPending.prompt
    );
  });
});
