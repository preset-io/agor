import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, UUID } from '@agor/core/types';
import { beforeEach, describe, expect, vi } from 'vitest';
import { ownedDbTest as dbTest } from '../../../../packages/core/src/db/test-helpers';
import { type RepoParams, ReposService } from './repos';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../utils/spawn-executor.js', async (original) => ({
  ...(await original<typeof import('../utils/spawn-executor.js')>()),
  spawnExecutorFireAndForget: mocks.spawn,
}));
const request = {
  url: 'https://example.invalid/synthetic/framework.git',
  slug: 'synthetic/framework',
  default_branch: 'main',
};
const params = {
  tenant: { tenant_id: 'tenant-a', source: 'explicit' },
  user: { user_id: '550e8400-e29b-41d4-a716-446655440004', role: 'member' },
} as AuthenticatedParams as RepoParams;

function setup(db: Parameters<typeof createTenantScopedDatabaseProxy>[0]) {
  const scoped = createTenantScopedDatabaseProxy(db, { requireScope: true });
  const generateCommandToken = vi.fn(async () => 'synthetic-command-token');
  const emit = vi.fn();
  const app = {
    get: () => ({ execution: { unix_user_mode: 'simple' } }),
    sessionTokenService: { generateCommandToken },
    settings: { authentication: { secret: 'synthetic-only' } },
    service: (name: string) => {
      if (name === 'repos') return service;
      throw new Error(`Unexpected service ${name}`);
    },
  } as unknown as Application;
  const service = new ReposService(scoped, app);
  service.emit = emit;
  return { service, scoped, emit, generateCommandToken };
}

beforeEach(() => mocks.spawn.mockReset());
describe('repository bootstrap (real SQLite, guarded tenant scope)', () => {
  dbTest(
    'fresh concurrent onboarding launches once; another user joins shared metadata',
    async ({ db }) => {
      const { service, emit } = setup(db);
      const calls = await Promise.all([
        service.cloneRepository(request, params),
        service.cloneRepository(request, params),
      ]);
      expect(calls.map((r) => r.status).sort()).toEqual(['exists', 'pending']);
      expect(calls[0].repo_id).toBe(calls[1].repo_id);
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.map((c) => c[0])).toEqual(['created']);
      const otherUser = {
        ...params,
        user: { ...params.user!, user_id: generateId() },
      } as RepoParams;
      await expect(service.cloneRepository(request, otherUser)).resolves.toMatchObject({
        status: 'exists',
        repo_id: calls[0].repo_id,
      });
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
      expect(mocks.spawn.mock.calls[0][0].params).toMatchObject({
        userId: params.user!.user_id,
        cloneGeneration: 1,
        importEnvironmentConfig: false,
      });
    }
  );

  dbTest(
    'failed clone with existing branches retries same row; stale exit cannot fail retry',
    async ({ db }) => {
      const { service, scoped } = setup(db);
      const first = await service.cloneRepository(request, params);
      const oldExit = mocks.spawn.mock.calls[0][1].onExit;
      await runWithTenantDatabaseScope(scoped, 'tenant-a', async () => {
        await service.patch(first.repo_id!, { clone_status: 'failed', clone_generation: 1 });
        await new BranchRepository(scoped).create({
          repo_id: first.repo_id as UUID,
          created_by: 'test-user' as UUID,
          name: 'existing-work',
          ref: 'main',
          path: '/tmp/synthetic/work',
          branch_unique_id: 4567,
        });
      });
      const retry = await service.cloneRepository(request, { ...params, query: { cleanup: true } });
      expect(retry).toEqual(first);
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(mocks.spawn.mock.calls[1][0].params.cloneGeneration).toBe(2);
      await oldExit(1);
      await runWithTenantDatabaseScope(scoped, 'tenant-a', async () => {
        expect(await service.get(first.repo_id!)).toMatchObject({
          clone_status: 'cloning',
          clone_generation: 2,
        });
        expect(
          await new BranchRepository(scoped).findAllByRepoId(first.repo_id as UUID)
        ).toHaveLength(1);
        expect(await new RepoRepository(scoped).count()).toBe(1);
      });
    }
  );

  dbTest(
    'dispatch happens after commit, never on rollback; synchronous launch failure is durable',
    async ({ db }) => {
      const { service, scoped } = setup(db);
      await expect(
        runWithTenantDatabaseTransaction(scoped, 'tenant-a', async () => {
          await service.cloneRepository(request, params);
          expect(mocks.spawn).not.toHaveBeenCalled();
          throw new Error('synthetic rollback');
        })
      ).rejects.toThrow('synthetic rollback');
      expect(mocks.spawn).not.toHaveBeenCalled();
      mocks.spawn.mockImplementationOnce(() => {
        throw new Error('synthetic launcher unavailable');
      });
      const result = await service.cloneRepository(request, params);
      await runWithTenantDatabaseScope(scoped, 'tenant-a', async () => {
        expect(await service.get(result.repo_id!)).toMatchObject({
          clone_status: 'failed',
          clone_error: { message: 'synthetic launcher unavailable' },
        });
      });
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
    }
  );

  dbTest(
    'authentication, member capability and conflicting tenant identity fail before writes',
    async ({ db }) => {
      const { service } = setup(db);
      await expect(service.cloneRepository(request)).rejects.toThrow('Authentication required');
      await expect(
        service.cloneRepository(request, {
          ...params,
          user: { ...params.user!, role: 'viewer' },
        } as RepoParams)
      ).rejects.toThrow('Member access');
      await expect(
        runWithTenantContext('tenant-b', () => service.cloneRepository(request, params))
      ).rejects.toThrow();
      await expect(
        service.patch(
          'untrusted-id',
          { clone_status: 'failed', clone_generation: 1 },
          { ...params, provider: 'rest' }
        )
      ).rejects.toThrow('managed by the Git executor');
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(await new RepoRepository(db).count()).toBe(0);
    }
  );
});
