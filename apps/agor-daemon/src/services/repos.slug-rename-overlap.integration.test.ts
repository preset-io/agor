import { getBranchPath } from '@agor/core/config';
import {
  BoardRepository,
  BranchMaintenanceRepository,
  createTenantScopedDatabaseProxy,
  RepoRepository,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import { Conflict } from '@agor/core/feathers';
import type { TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import {
  createBranchAtPathForTest,
  setBranchPathForTest,
} from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
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
// slug's branches still hold. Branch creation must refuse to share them, also
// when the victim row predates the documented data_home migration and names
// the legacy `<agor home>/worktrees` alias for the same directory.
dbTest.for([
  ['the current root', false],
  ['the legacy alias', true],
] as const)(
  'a repo renamed onto another repo slug cannot reuse workspaces stored under %s',
  async ([, legacy], { db: raw }) => {
    vi.stubEnv('AGOR_HOME', '/fictional/home/.agor');
    vi.stubEnv('AGOR_DATA_HOME', '/fictional/data');
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
      expect(original.path).toBe('/fictional/data/worktrees/org/v/feature');
      if (legacy) {
        await setBranchPathForTest(
          raw,
          original.branch_id,
          '/fictional/home/.agor/worktrees/org/v/feature'
        );
      }

      await rename(victim.repo_id, 'org/v-old');
      await rename(attacker.repo_id, 'org/v');

      for (const name of ['feature', 'feature/x']) {
        const attempt = create(attacker.repo_id, name);
        await expect(attempt).rejects.toBeInstanceOf(Conflict);
        await expect(attempt).rejects.toThrow(/would share a workspace path with another branch/);
      }
      expect((await create(attacker.repo_id, 'other')).path).toBe(
        getBranchPath('org/v', 'other', 'slug-rename-test')
      );

      // A pair that predates the fence (planted directly) must not let the
      // attacker's row delete or rewrite the victim's directory either.
      const planted = await scoped(() =>
        createBranchAtPathForTest(db, {
          repo_id: attacker.repo_id,
          name: 'planted',
          ref: 'planted',
          branch_unique_id: 9700001,
          path: getBranchPath('org/v', 'feature', 'slug-rename-test'),
          created_by: owner.user_id,
          archived: true,
        })
      );
      for (const kind of ['delete', 'cleanup', 'workspace_write'] as const) {
        await expect(
          scoped(() => new BranchMaintenanceRepository(db).claim(planted.branch_id, kind))
        ).rejects.toThrow('overlaps');
      }
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  }
);
