import { describe, expect, it } from 'vitest';
import type { SessionInitializationResult, SessionInitializationRetry } from './sessionCreation';
import {
  createSessionInitializationRecoveryState,
  pruneSessionInitializationRecovery,
  recordSessionInitializationResult,
  scopeSessionInitializationRecovery,
} from './sessionInitializationRecovery';

const retry: SessionInitializationRetry = {
  content: { prompt: 'private draft', idempotencyKey: 'request-key' },
};

function retryable(sessionId: string): SessionInitializationResult {
  return {
    status: 'retryable',
    sessionId,
    setup: { mcpServers: 'not-requested', environmentVariables: 'not-requested' },
    delivery: { prompt: 'failed', attachments: 'not-requested', retry: retry.content },
    retry,
  };
}

describe('session initialization recovery', () => {
  it('drops retained payloads when the authenticated user changes', () => {
    const userAState = recordSessionInitializationResult(
      createSessionInitializationRecoveryState('user-a'),
      'user-a',
      retryable('session-shared'),
      true
    );

    const userBState = scopeSessionInitializationRecovery(userAState, 'user-b');

    expect(userBState.ownerId).toBe('user-b');
    expect(userBState.retries.size).toBe(0);
  });

  it('rejects an in-flight result completed after an account switch', () => {
    const switchedState = scopeSessionInitializationRecovery(
      createSessionInitializationRecoveryState('user-a'),
      'user-b'
    );

    const result = recordSessionInitializationResult(
      switchedState,
      'user-a',
      retryable('session-shared'),
      true
    );

    expect(result).toBe(switchedState);
    expect(result.retries.size).toBe(0);
  });

  it('removes retained payloads when their session is deleted', () => {
    const state = recordSessionInitializationResult(
      createSessionInitializationRecoveryState('user-a'),
      'user-a',
      retryable('session-deleted'),
      true
    );

    const pruned = pruneSessionInitializationRecovery(state, () => false);

    expect(pruned.retries.size).toBe(0);
  });
});
