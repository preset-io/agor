import type { Session } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { runSessionCreationStages } from './sessionCreation';

const session = { session_id: 'session-1' } as Session;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('runSessionCreationStages', () => {
  it('does not publish or upload a session whose create resolves after an A→B switch', async () => {
    const create = deferred<Session>();
    let currentOwner = 'user-a:1';
    const onSessionCreated = vi.fn();
    const preparePrompt = vi.fn().mockResolvedValue('prepared');
    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const operation = runSessionCreationStages({
      createSession: () => create.promise,
      onSessionCreated,
      initialPrompt: 'hello',
      preparePrompt,
      initializeSession,
      shouldContinue: () => currentOwner === 'user-a:1',
    });

    currentOwner = 'user-b:2';
    create.resolve(session);

    await expect(operation).resolves.toEqual({ status: 'cancelled' });
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(preparePrompt).not.toHaveBeenCalled();
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it('does not initialize after the same user establishes a new auth generation', async () => {
    const prepared = deferred<string>();
    let authenticationGeneration = 1;
    const onSessionCreated = vi.fn();
    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const operation = runSessionCreationStages({
      createSession: vi.fn().mockResolvedValue(session),
      onSessionCreated,
      initialPrompt: 'hello',
      preparePrompt: () => prepared.promise,
      initializeSession,
      shouldContinue: () => authenticationGeneration === 1,
    });

    await Promise.resolve();
    expect(onSessionCreated).toHaveBeenCalledWith(session);
    authenticationGeneration = 2;
    prepared.resolve('prepared');

    await expect(operation).resolves.toEqual({ status: 'cancelled' });
    expect(initializeSession).not.toHaveBeenCalled();
  });
});
