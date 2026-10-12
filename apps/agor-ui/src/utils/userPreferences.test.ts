import type { AgorClient } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { patchUserPreferences } from './userPreferences';

describe('patchUserPreferences', () => {
  it('lays the change over the latest preferences, not a stale copy', async () => {
    const patch = vi.fn(async (_id: string, data: unknown) => data);
    const client = {
      service: () => ({
        get: async () => ({ user_id: 'u1', preferences: { audio: { enabled: true } } }),
        patch,
      }),
    } as unknown as AgorClient;
    await patchUserPreferences(client, 'u1', { homeWorkView: 'board' });
    expect(patch).toHaveBeenCalledWith('u1', {
      preferences: { audio: { enabled: true }, homeWorkView: 'board' },
    });
  });
});
