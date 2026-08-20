import { describe, expect, it, vi } from 'vitest';
import type { SessionInitializationResult, SessionInitializationRetry } from './sessionCreation';
import { initializeCreatedSession } from './sessionCreation';
import {
  createSessionInitializationRecoveryState,
  pruneSessionInitializationRecovery,
  recordSessionInitializationResult,
  runSessionInitializationSingleFlight,
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

  it('runs concurrent attachment retries once and clears recovery monotonically', async () => {
    let releaseUpload!: (prompt: string) => void;
    const uploadAttachments = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseUpload = resolve;
        })
    );
    const sendPrompt = vi.fn().mockResolvedValue(true);
    const flights = new Map<string, Promise<SessionInitializationResult>>();
    const initialization = {
      content: {
        ...retry.content,
        attachmentFiles: [new File(['image'], 'shot.png')],
      },
    };
    const operation = () =>
      initializeCreatedSession('session-shared', initialization, {
        associateMcpServer: vi.fn(),
        updateEnvironmentVariables: vi.fn(),
        uploadAttachments,
        sendPrompt,
      });

    const first = runSessionInitializationSingleFlight(flights, 'user-a:session-shared', operation);
    const second = runSessionInitializationSingleFlight(
      flights,
      'user-a:session-shared',
      operation
    );

    expect(second).toBe(first);
    expect(uploadAttachments).toHaveBeenCalledTimes(1);
    releaseUpload('private draft\n\n[shot](files/shot.png)');
    const outcomes = await Promise.all([first, second]);

    let state = recordSessionInitializationResult(
      createSessionInitializationRecoveryState('user-a'),
      'user-a',
      retryable('session-shared'),
      true
    );
    for (const outcome of outcomes) {
      state = recordSessionInitializationResult(state, 'user-a', outcome, true);
    }
    expect(uploadAttachments).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(state.retries.size).toBe(0);
  });
});
