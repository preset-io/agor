import {
  createTenantScopedDatabaseProxy,
  MissingTenantDatabaseScopeError,
  runWithTenantContext,
} from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import { bindStopRouteRepositories } from './utils/stop-route-repositories.js';

describe('Stop route transaction scope', () => {
  it('gives normal Stop and force-unverified ownership checks short guarded DB scopes', async () => {
    const transaction = async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        execute: async () => [],
        marker: () => 'scoped',
      });
    const rawDb = {
      transaction,
      marker: () => 'scoped',
    };
    const guardedDb = createTenantScopedDatabaseProxy(rawDb as never, {
      requireScope: true,
      label: 'Stop test DB',
    });
    const repositories = bindStopRouteRepositories(guardedDb, {
      taskRepo: {
        async findQueued() {
          return (guardedDb as unknown as { marker(): string }).marker() === 'scoped' ? [] : [];
        },
      },
      branchRepo: {
        async isOwner() {
          return (guardedDb as unknown as { marker(): string }).marker() === 'scoped';
        },
      },
    });

    expect(() => (guardedDb as unknown as { marker(): string }).marker()).toThrow(
      MissingTenantDatabaseScopeError
    );

    await runWithTenantContext('tenant-a', async () => {
      await expect(repositories.taskRepo.findQueued('session-a')).resolves.toEqual([]);
      await expect(
        repositories.branchRepo.isOwner('branch-a' as never, 'user-a' as never)
      ).resolves.toBe(true);
    });
  });
});
