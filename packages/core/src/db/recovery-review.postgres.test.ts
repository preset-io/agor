import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateId } from '../lib/ids';
import type { TenantID, UploadMetadata, UploadOwner, UploadRef } from '../types';
import { createDatabase, type Database } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { BoardRepository } from './repositories/boards';
import { BranchMaintenanceRepository } from './repositories/branch-maintenance';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { SessionRepository } from './repositories/sessions';
import { TaskRepository } from './repositories/tasks';
import { UploadRepository } from './repositories/uploads';
import { UserPrimaryTeammateRepository } from './repositories/user-primary-teammate';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'recovery review races and RLS',
  () => {
    let first: Database;
    let second: Database;
    beforeAll(async () => {
      first = createDatabase({ dialect: 'postgresql', url: url! });
      second = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(first);
      expect(
        rawRows(
          await executeRaw(
            first,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }, 60000);
    afterAll(async () => {
      for (const db of [first, second])
        await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });
    it('stale rename cannot erase committed primary; retirement is tenant-scoped and excludes concurrent designation', async () => {
      const a = `review-a-${generateId()}` as TenantID;
      const b = `review-b-${generateId()}` as TenantID;
      const one = createTenantScopedDatabaseProxy(first, { requireScope: true });
      const two = createTenantScopedDatabaseProxy(second, { requireScope: true });
      const fixture = await runWithTenantDatabaseScope(one, a, async () => {
        const { branch, user } = await seedEnvironmentCommandBranch(one);
        const board = await new BoardRepository(one).create({
          name: 'Original',
          created_by: user.user_id,
        });
        await new BranchRepository(one).update(branch.branch_id, {
          board_id: board.board_id,
          custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture' } },
        });
        return { branch, user, board };
      });
      const { branch, user, board } = fixture;
      await runWithTenantDatabaseScope(one, a, async () => {
        const boards = new BoardRepository(one);
        const read = boards.findById.bind(boards);
        vi.spyOn(boards, 'findById').mockImplementationOnce(async (id) => {
          const stale = await read(id);
          await runWithTenantDatabaseScope(two, a, () =>
            new BoardRepository(two).setPrimaryTeammate(board.board_id, branch.branch_id)
          );
          return stale;
        });
        await boards.update(board.board_id, { name: 'Renamed' });
        expect(await boards.findById(board.board_id)).toMatchObject({
          name: 'Renamed',
          primary_teammate_id: branch.branch_id,
        });
        await expect(
          new BranchMaintenanceRepository(one).claim(branch.branch_id, 'cleanup')
        ).rejects.toThrow('Primary teammate is protected');
      });
      await runWithTenantDatabaseScope(two, b, async () => {
        await expect(
          new BoardRepository(two).setPrimaryTeammate(board.board_id, branch.branch_id)
        ).rejects.toThrow();
        await expect(
          new BranchMaintenanceRepository(two).claimForTeammateRetirement(
            branch.branch_id,
            user.user_id,
            async () => {}
          )
        ).rejects.toThrow('not found');
        await new UserPrimaryTeammateRepository(two).clearPrimaryTeammate(user.user_id);
      });
      await runWithTenantDatabaseScope(one, a, async () => {
        await new BoardRepository(one).clearPrimaryTeammate(board.board_id);
        await new UserPrimaryTeammateRepository(one).setPrimaryTeammate(
          user.user_id,
          branch.branch_id,
          { source: 'explicit' }
        );
      });
      const results = await Promise.allSettled([
        runWithTenantDatabaseScope(one, a, () =>
          new BranchMaintenanceRepository(one).claimForTeammateRetirement(
            branch.branch_id,
            user.user_id,
            async () => {}
          )
        ),
        runWithTenantDatabaseScope(two, a, () =>
          new UserPrimaryTeammateRepository(two).setPrimaryTeammate(
            user.user_id,
            branch.branch_id,
            { source: 'explicit' }
          )
        ),
      ]);
      expect(results[0].status).toBe('fulfilled');
      await runWithTenantDatabaseScope(one, a, async () => {
        expect(await new UserPrimaryTeammateRepository(one).getBranchId(user.user_id)).toBeNull();
        expect(await new BranchRepository(one).findById(branch.branch_id)).toMatchObject({
          archived: true,
        });
      });
    });
    it('guarded historical task/upload admission fails through failure and retry; foreign tenant cannot restore or upload', async () => {
      const a = `admission-a-${generateId()}` as TenantID;
      const b = `admission-b-${generateId()}` as TenantID;
      const db = createTenantScopedDatabaseProxy(first, { requireScope: true });
      const fixture = await runWithTenantDatabaseScope(db, a, async () => {
        const { branch, user } = await seedEnvironmentCommandBranch(db);
        const session = await new SessionRepository(db).create({
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'codex',
        });
        await new BranchRepository(db).update(branch.branch_id, { filesystem_status: 'cleaned' });
        return { branch, user, session };
      });
      const { branch, user, session } = fixture;
      const owner: UploadOwner = {
        tenantId: a,
        branchId: branch.branch_id,
        sessionId: session.session_id,
        createdBy: user.user_id,
      };
      const metadata: UploadMetadata = {
        ref: String(generateId()) as UploadRef,
        name: 'fixture.txt',
        size: 1,
        mimeType: 'text/plain',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        provenance: 'browser',
      };
      await runWithTenantDatabaseScope(db, a, async () => {
        const branches = new BranchRepository(db);
        const attempt = () =>
          new TaskRepository(db).create({
            session_id: session.session_id,
            created_by: user.user_id,
            status: 'queued',
          });
        const reject = async () => {
          await expect(attempt()).rejects.toThrow(/filesystem/);
          await expect(new UploadRepository(db).reserve(owner, metadata)).rejects.toThrow(
            /filesystem/
          );
        };
        await branches.claimForProvisioning(branch.branch_id, 'first', { restore: true });
        await reject();
        await branches.acknowledgeProvisioningAttempt(
          branch.branch_id,
          { filesystem_status: 'failed' },
          'first'
        );
        await reject();
        expect(
          (await branches.claimForProvisioning(branch.branch_id, 'retry', { restore: true }))
            .claimed
        ).toBe(true);
        await reject();
        await branches.acknowledgeProvisioningAttempt(
          branch.branch_id,
          { filesystem_status: 'ready' },
          'retry'
        );
        expect(await attempt()).toMatchObject({ status: 'queued' });
        await new UploadRepository(db).reserve(owner, metadata);
      });
      await runWithTenantDatabaseScope(db, b, async () => {
        await expect(
          new BranchRepository(db).claimForProvisioning(branch.branch_id, 'foreign', {
            restore: true,
          })
        ).rejects.toThrow();
        await expect(
          new UploadRepository(db).reserve(
            { ...owner, tenantId: b },
            { ...metadata, ref: String(generateId()) as UploadRef }
          )
        ).rejects.toThrow('not found');
        await expect(
          new TaskRepository(db).create({
            session_id: session.session_id,
            created_by: user.user_id,
            status: 'queued',
          })
        ).rejects.toThrow();
      });
    });
  }
);
