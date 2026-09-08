import { readFileSync } from 'node:fs';
import {
  createTenantScopedDatabaseProxy,
  MissingTenantDatabaseScopeError,
  runWithTenantContext,
} from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import { createRequiredTenantDatabaseRunner } from './register-routes.js';
import { bindStopRouteRepositories } from './utils/stop-route-repositories.js';

describe('Stop route transaction scope', () => {
  it('wires short tenant DB units and session-level RBAC through every Stop path', () => {
    const source = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');
    const stop = source.slice(
      source.indexOf('// Stop endpoint'),
      source.indexOf('// Queue listing', source.indexOf('// Stop endpoint'))
    );

    expect(stop).toContain('resolveSessionPromptAccess({');
    expect(stop).toContain('body.force_unverified !== true');
    const stopAccessScope = stop.slice(
      stop.indexOf('const access = await inCurrentTenantDatabaseScope'),
      stop.indexOf(
        'if (!access)',
        stop.indexOf('const access = await inCurrentTenantDatabaseScope')
      )
    );
    expect(stopAccessScope).toContain('resolveSessionPromptAccess({');
    expect(stop).toContain(
      'runInFreshTenantWriteDatabase: runInFreshTerminationTenantWriteDatabase'
    );
    expect(stop).toContain('runInTenantDatabaseScope: inCurrentTenantDatabaseScope');
    expect(stop).toContain('!isCanonicalFullUuid(body.expected_task_id)');
    expect(stop).toContain('{ reason: stopReason, expectedTaskId }');
    expect(stop).toContain("outcome: 'force_failed' as const");
    expect(stop).toMatch(
      /const forceFail = await runInFreshTerminationTenantWriteDatabase\(\(\) =>\s+forceFailUnverifiedTask\(\{/
    );
  });

  it('production-injected long-route runner activates the guarded tenant unit', async () => {
    const rawDb = {
      transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({ execute: async () => [], marker: () => 'scoped' }),
      marker: () => 'unscoped',
    };
    const guardedDb = createTenantScopedDatabaseProxy(rawDb as never, {
      requireScope: true,
      label: 'route dependency test DB',
    });
    const runDatabaseUnit = createRequiredTenantDatabaseRunner(guardedDb);

    await runWithTenantContext('tenant-a', async () => {
      await expect(
        runDatabaseUnit(async () => (guardedDb as unknown as { marker(): string }).marker())
      ).resolves.toBe('scoped');
    });
  });

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
