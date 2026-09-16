import type { AgorClient } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { startTeammateBootstrapSession } from './startTeammateBootstrapSession';

describe('teammate readiness before first session', () => {
  it.each(['ready', 'failed'] as const)(
    'starts only after actual filesystem readiness: %s',
    async (filesystem_status) => {
      let finish!: (value: unknown) => void;
      const get = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const client = { service: () => ({ get }) } as unknown as AgorClient;
      const onCreateSession = vi.fn(async () => ({ sessionId: 'first' }));
      const result = startTeammateBootstrapSession({
        client,
        branchId: 'home',
        boardId: 'board',
        sessionConfig: {},
        onCreateSession,
      });
      expect(onCreateSession).not.toHaveBeenCalled();
      finish({ filesystem_status, error_message: 'Persona clone failed' });
      if (filesystem_status === 'ready') {
        await expect(result).resolves.toEqual({ sessionId: 'first' });
        expect(onCreateSession).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toThrow('Persona clone failed');
        expect(onCreateSession).not.toHaveBeenCalled();
      }
    }
  );
});
