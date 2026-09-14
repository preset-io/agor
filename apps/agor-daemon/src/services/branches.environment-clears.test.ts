import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchEnvironmentInstance } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { BranchesService } from './branches';

const stamp = '2026-01-01T00:00:00.000Z';
const failed: BranchEnvironmentInstance = {
  status: 'error',
  process: { pid: 12345, started_at: stamp },
  last_error: 'PR2682_FAIL',
  last_command: { action: 'start', status: 'failed', timestamp: stamp },
  last_health_check: { status: 'unhealthy', timestamp: stamp },
  logs: ['old output'],
  access_urls: [{ name: 'Preview', url: 'https://preview.example.test' }],
};

// Use the real service, patch implementation and repository. A shallow patch
// mock hid the live defect: deleting keys before the repository merge restores
// their old persisted values.
dbTest(
  'failure -> Stop -> successful Start -> Stop/Nuke durably clears stale metadata',
  async ({ db }) => {
    const { branch } = await seedEnvironmentCommandBranch(db);
    const guarded = createTenantScopedDatabaseProxy(db, { label: 'daemon database' });
    const emit = vi.fn();
    const app = { get: () => ({}), service: () => ({ emit }) } as unknown as Application;
    const service = new BranchesService(guarded, app);
    const read = () =>
      runWithTenantDatabaseScope(guarded, 'default', () =>
        new BranchRepository(guarded).findById(branch.branch_id)
      );
    await runWithTenantContext('default', async () => {
      await service.updateEnvironment(branch.branch_id, failed);
      expect((await read())?.environment_instance?.last_error).toBe('PR2682_FAIL');
      for (const action of ['stop', 'nuke'] as const) {
        const stopped = await service.updateEnvironment({
          branch_id: branch.branch_id,
          environment_update: {
            status: 'stopped',
            process: null,
            last_error: null,
            last_command: { action, status: 'succeeded', timestamp: stamp },
          },
        });
        for (const env of [stopped.environment_instance, (await read())?.environment_instance]) {
          expect(env).toMatchObject({
            status: 'stopped',
            last_command: { action, status: 'succeeded' },
          });
          expect(env).not.toHaveProperty('process');
          expect(env).not.toHaveProperty('last_error');
          expect(env?.access_urls).toEqual(failed.access_urls);
        }
        // Covers the daemon's beginLifecycle path and in-process undefined clears.
        await service.updateEnvironment(
          branch.branch_id,
          {
            status: 'starting',
            process: { started_at: stamp },
            last_error: undefined,
            last_command: undefined,
            last_health_check: undefined,
            logs: undefined,
          },
          undefined,
          { beginLifecycle: true }
        );
        const starting = (await read())?.environment_instance;
        for (const key of ['last_error', 'last_command', 'last_health_check', 'logs'])
          expect(starting).not.toHaveProperty(key);
        expect(starting?.process).toEqual({ started_at: stamp });
        await service.updateEnvironment(branch.branch_id, {
          status: 'running',
          last_command: { action: 'start', status: 'succeeded', timestamp: stamp },
        });
        expect((await read())?.environment_instance).not.toHaveProperty('last_error');
      }
      await service.updateEnvironment(branch.branch_id, { status: 'stopped', process: undefined });
      expect((await read())?.environment_instance).not.toHaveProperty('process');
      expect(emit).toHaveBeenCalled();
    });
  }
);

dbTest('clearing an already absent field is observation-only and does not emit', async ({ db }) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const emit = vi.fn();
  const app = { get: () => ({}), service: () => ({ emit }) } as unknown as Application;
  const service = new BranchesService(db, app);
  await runWithTenantContext('default', () =>
    service.updateEnvironment(branch.branch_id, { last_error: null })
  );
  const saved = await new BranchRepository(db).findById(branch.branch_id);
  expect(saved?.environment_instance).toEqual({ status: 'stopped' });
  expect(saved?.updated_at).toBe(branch.updated_at);
  expect(emit).not.toHaveBeenCalled();
});
