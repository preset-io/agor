import { getBranchPath } from '@agor/core/config';
import {
  BoardRepository,
  createTenantScopedDatabaseProxy,
  RepoRepository,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import { Conflict } from '@agor/core/feathers';
import type { TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { boardMetadataTestApp } from '../../test/board-metadata-app';
import type { RegisterHooksContext } from '../register-hooks';
import { ReposService } from './repos';

vi.mock('../utils/spawn-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/spawn-executor')>()),
  requestExecutor: vi.fn(async () => ({ success: true, data: { exists: false } })),
  spawnExecutor: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(),
}));

// A repo slug rename is DB-only, so a renamed repo derives the paths its old
// slug's branches still hold. Branch creation must refuse to share them.
dbTest(
  'a repo renamed onto another repo slug cannot reuse that repo workspaces',
  async ({ db: raw }) => {
    const owner = await new UsersRepository(raw).create({
      email: 'member@example.test',
      role: 'member',
    });
    const board = await new BoardRepository(raw).create({
      name: 'Fictional board',
      created_by: owner.user_id,
    });
    const repos = new RepoRepository(raw);
    const victim = await repos.create({
      name: 'Victim',
      slug: 'org/v',
      repo_type: 'local',
      local_path: '/fictional/v',
      default_branch: 'main',
    });
    const attacker = await repos.create({
      name: 'Attacker',
      slug: 'org/r1',
      repo_type: 'local',
      local_path: '/fictional/r1',
      default_branch: 'main',
    });
    const db = createTenantScopedDatabaseProxy(raw, { label: 'slug-rename-overlap' });
    const config = {
      database: { dialect: 'sqlite' },
      execution: {},
      multi_tenancy: { mode: 'static', static_tenant_id: 'slug-rename-test' },
    } as RegisterHooksContext['config'];
    const server = await boardMetadataTestApp(db, config);
    await server.app.unuse('repos');
    const service = new ReposService(db, server.app);
    server.app.use('repos', service);
    Object.assign(server.app, {
      sessionTokenService: { generateCommandToken: vi.fn(async () => 'fictional-token') },
    });
    const params = {
      user: owner,
      tenant: { tenant_id: 'slug-rename-test' as TenantID, source: 'explicit' as const },
    };
    const scoped = <T>(work: () => Promise<T>) =>
      runWithTenantDatabaseScope(db, 'slug-rename-test', work);
    const create = (repoId: string, name: string) =>
      scoped(() =>
        service.createBranch(
          repoId,
          { name, ref: name, createBranch: true, sourceBranch: 'main', boardId: board.board_id },
          params as never
        )
      );
    const rename = (repoId: string, slug: string) =>
      scoped(() => service.updateMetadata(repoId, { slug }, params as never));
    try {
      const original = await create(victim.repo_id, 'feature');
      expect(original.path).toBe(getBranchPath('org/v', 'feature', 'slug-rename-test'));

      await rename(victim.repo_id, 'org/v-old');
      await rename(attacker.repo_id, 'org/v');

      for (const name of ['feature', 'feature/x']) {
        const attempt = create(attacker.repo_id, name);
        await expect(attempt).rejects.toBeInstanceOf(Conflict);
        await expect(attempt).rejects.toThrow(/would share a workspace with branch 'feature'/);
      }
      expect((await create(attacker.repo_id, 'other')).path).toBe(
        getBranchPath('org/v', 'other', 'slug-rename-test')
      );
    } finally {
      await server.close();
    }
  }
);
