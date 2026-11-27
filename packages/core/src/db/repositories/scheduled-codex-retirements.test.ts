import { expect } from 'vitest';
import { runWithTenantContext } from '../tenant-context';
import { dbTest } from '../test-helpers';
import {
  admitCodexThreadReference,
  ScheduledCodexRetirementRepository,
} from './scheduled-codex-retirements';

dbTest(
  'the retirement survives a worker failure and fences equivalent thread handles',
  async ({ db }) => {
    const repo = new ScheduledCodexRetirementRepository(db);
    const id = '00000000-0000-4000-a000-00000000000a';
    await runWithTenantContext('tenant-one', () =>
      repo.stage({
        session_id: 'session-one',
        thread_id: id,
        branch_id: 'branch-one',
        user_id: 'user-one',
      })
    );
    const now = new Date(Date.now() + 1_000);
    const retry = new Date(now.getTime() + 500);
    await runWithTenantContext('tenant-one', async () => {
      await expect(admitCodexThreadReference(db, 'branch-one', id.toUpperCase())).rejects.toThrow(
        'being retired'
      );
      expect(await repo.due(now, 2)).toMatchObject([{ session_id: 'session-one' }]);
      const first = await repo.claim('session-one', now, retry);
      expect(first?.thread_id).toBe(id);
      expect(await repo.claim('session-one', now, retry)).toBeFalsy();
      const afterFailure = new ScheduledCodexRetirementRepository(db);
      const next = await afterFailure.claim('session-one', retry, new Date(retry.getTime() + 500));
      expect(next?.session_id).toBe('session-one');
      if (!first || !next) throw new Error('Retirement fixture was not claimed');
      await repo.settle(first, retry);
      expect(await repo.due(new Date(retry.getTime() + 1_000), 2)).toHaveLength(1);
      await afterFailure.settle(next, retry);
      expect(await repo.due(new Date(retry.getTime() + 1_000), 2)).toEqual([]);
    });
  }
);
