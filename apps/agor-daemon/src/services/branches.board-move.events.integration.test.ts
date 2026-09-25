import {
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  runWithTenantDatabaseTransaction,
} from '@agor/core/db';
import type { Branch, HookContext, TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { boardMetadataTestApp } from '../../test/board-metadata-app';
import type { BranchesService } from './branches';

for (const method of ['patch', 'update'] as const) {
  for (const rollback of [false, true]) {
    dbTest(
      `board move ${method}: ${rollback ? 'rollback is silent' : 'commit emits once'}`,
      async ({ db: raw }) => {
        const { branch, user } = await seedEnvironmentCommandBranch(raw);
        const boards = new BoardRepository(raw);
        const source = await boards.create({ name: 'Source', created_by: user.user_id });
        const target = await boards.create({ name: 'Target', created_by: user.user_id });
        const branches = new BranchRepository(raw);
        await branches.update(branch.branch_id, { board_id: source.board_id });
        const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
        const tenant = { tenant_id: 'default' as TenantID, source: 'explicit' as const };
        const server = await boardMetadataTestApp(db, {
          database: { dialect: 'sqlite' },
          execution: {},
          multi_tenancy: { mode: 'static', static_tenant_id: tenant.tenant_id },
        } as Parameters<typeof boardMetadataTestApp>[1]);
        const service = server.app.service('branches') as unknown as BranchesService;
        const emitted = vi.fn<(value: Branch, context: HookContext) => void>();
        const event = method === 'patch' ? 'patched' : 'updated';
        server.app.service('branches').on(event, emitted);
        try {
          const move = () =>
            runWithTenantDatabaseTransaction(db, tenant.tenant_id, async () => {
              // A conflicting caller tenant cannot borrow this transaction or emit.
              await expect(
                runWithTenantDatabaseTransaction(db, 'foreign', () =>
                  service[method](branch.branch_id, { board_id: target.board_id }, { user, tenant })
                )
              ).rejects.toThrow('Cannot enter tenant transaction foreign');
              await service[method](
                branch.branch_id,
                { board_id: target.board_id },
                { user, tenant }
              );
              expect(emitted).not.toHaveBeenCalled();
              if (rollback) throw new Error('rollback board move');
            });
          if (rollback) {
            await expect(move()).rejects.toThrow('rollback board move');
            expect(emitted).not.toHaveBeenCalled();
          } else {
            await move();
            expect(emitted).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ branch_id: branch.branch_id, board_id: target.board_id }),
              expect.objectContaining({
                path: 'branches',
                method,
                event,
                params: expect.objectContaining({ user, tenant }),
              })
            );
          }
          expect((await branches.findById(branch.branch_id))?.board_id).toBe(
            rollback ? source.board_id : target.board_id
          );
        } finally {
          await server.close();
        }
      }
    );
  }
}
