import { describe, expect, it, vi } from 'vitest';
import { OpenCodeCleanupUnverifiedError } from './managed-server.js';
import { OpenCodeTool } from './opencode-tool.js';

type AbortResponse = { data: boolean; error: undefined } | { data: undefined; error: unknown };

type AbortClient = {
  session: {
    abort: (input: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<AbortResponse>;
  };
};

function abortActiveSession(client: AbortClient): Promise<void> {
  const tool = new OpenCodeTool({});
  return (
    tool as unknown as {
      abortActiveSession(
        client: AbortClient,
        openCodeSessionId: string,
        directory: string
      ): Promise<void>;
    }
  ).abortActiveSession(client, 'session-1', '/workspace');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function settleRuntimeCleanup(
  activeSessionAbort: Promise<void>,
  collectorStop: Promise<void>,
  close: () => Promise<void>
): Promise<void> {
  const tool = new OpenCodeTool({});
  return (
    tool as unknown as {
      settleRuntimeCleanup(
        activeSessionAbort: Promise<void>,
        collectorStop: Promise<void>,
        close: () => Promise<void>
      ): Promise<void>;
    }
  ).settleRuntimeCleanup(activeSessionAbort, collectorStop, close);
}

describe('OpenCodeTool abort cleanup', () => {
  it('keeps the managed server alive until active-session abort settles', async () => {
    const activeSessionAbort = deferred<void>();
    const collectorStop = deferred<void>();
    const close = vi.fn(async () => undefined);
    const cleanup = settleRuntimeCleanup(activeSessionAbort.promise, collectorStop.promise, close);

    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    activeSessionAbort.resolve();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    collectorStop.resolve();

    await expect(cleanup).resolves.toBeUndefined();
  });

  it('still closes the managed server when active-session abort fails', async () => {
    const abortFailure = new OpenCodeCleanupUnverifiedError('abort transport failed');
    const close = vi.fn(async () => undefined);

    await expect(
      settleRuntimeCleanup(Promise.reject(abortFailure), Promise.resolve(), close)
    ).rejects.toBe(abortFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves a successful SDK abort response', async () => {
    const abort = vi.fn(async () => ({ data: true, error: undefined }) as const);

    await expect(abortActiveSession({ session: { abort } })).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: '/workspace' },
    });
  });

  it('converts a thrown SDK abort error into cleanup-unverified failure', async () => {
    const sdkError = new Error('abort transport failed');
    const abort = vi.fn(async () => {
      throw sdkError;
    });

    await expect(abortActiveSession({ session: { abort } })).rejects.toMatchObject({
      name: 'OpenCodeCleanupUnverifiedError',
      cause: sdkError,
    });
  });

  it.each([
    ['negative', { data: false, error: undefined }],
    ['error', { data: undefined, error: { name: 'NotFoundError' } }],
  ] as const)(
    'converts an SDK %s abort response into cleanup-unverified failure',
    async (_, reply) => {
      const abort = vi.fn(async () => reply);

      await expect(abortActiveSession({ session: { abort } })).rejects.toBeInstanceOf(
        OpenCodeCleanupUnverifiedError
      );
    }
  );
});
