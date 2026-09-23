import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeProgress } from './progress';
import { withKnowledgeTransfer } from './transfer-lifecycle';

afterEach(() => vi.restoreAllMocks());

describe('transfer lifecycle', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'propagates %s cancellation and removes only its own listeners',
    async (event) => {
      const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
      const cleanup = vi.fn(async () => {});
      const close = vi.spyOn(KnowledgeProgress.prototype, 'close').mockImplementation(() => {});
      const result = await withKnowledgeTransfer(
        { failureNote: 'Resume safely', cleanup },
        async ({ signal }) => {
          expect(signal.aborted).toBe(false);
          const handler = process
            .listeners(event)
            .find((listener) => !before[event].includes(listener));
          expect(handler).toBeDefined();
          // Invoke our handler without sending an OS signal to the test runner.
          handler!(event);
          expect(signal.aborted).toBe(true);
          return 'completed';
        }
      );
      expect(result).toBe('completed');
      expect(process.listeners('SIGINT')).toEqual(before.SIGINT);
      expect(process.listeners('SIGTERM')).toEqual(before.SIGTERM);
      expect(close).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
    }
  );

  it('reports failures, preserves the error, and cleans up before rejecting', async () => {
    const before = process.listeners('SIGINT');
    const error = new Error('Conflict');
    const cleanup = vi.fn(async () => {});
    const failure = vi.spyOn(KnowledgeProgress.prototype, 'failure').mockImplementation(() => {});
    const close = vi.spyOn(KnowledgeProgress.prototype, 'close').mockImplementation(() => {});
    await expect(
      withKnowledgeTransfer({ failureNote: 'Do not overwrite', cleanup }, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(failure).toHaveBeenCalledWith('Do not overwrite');
    expect(close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('still releases the client if closing progress output fails', async () => {
    const cleanup = vi.fn(async () => {});
    vi.spyOn(KnowledgeProgress.prototype, 'close').mockImplementation(() => {
      throw new Error('Output closed');
    });
    await expect(
      withKnowledgeTransfer({ failureNote: 'Resume', cleanup }, async () => 1)
    ).rejects.toThrow('Output closed');
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
