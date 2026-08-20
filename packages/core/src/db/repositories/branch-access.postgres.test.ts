/**
 * PostgreSQL regression coverage for the shared branch/board RBAC predicates.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/repositories/branch-access.postgres.test.ts
 */

import type { BranchID, UUID } from '@agor/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { GroupRepository } from './groups';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'branch and board RBAC predicates (PostgreSQL RLS)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    });

    it('preserves the permission matrix, moved-primary visibility, and tenant isolation', async () => {
      const tenantA = `rbac-query-a-${generateId()}`;
      const tenantB = `rbac-query-b-${generateId()}`;
      const viewerId = generateId() as UUID;
      let foreignSharedBoardId!: string;

      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const foreignOwner = await new UsersRepository(scoped).create({
          email: `foreign-owner-${generateId()}@example.com`,
          role: 'member',
        });
        foreignSharedBoardId = (
          await new BoardRepository(scoped).create({
            name: 'Other tenant shared board',
            created_by: foreignOwner.user_id as UUID,
            access_mode: 'shared',
          })
        ).board_id;
      });

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const users = new UsersRepository(scoped);
        const boards = new BoardRepository(scoped);
        const branches = new BranchRepository(scoped);
        const groups = new GroupRepository(scoped);
        const repos = new RepoRepository(scoped);
        const sessions = new SessionRepository(scoped);

        const ownerId = (
          await users.create({
            email: `owner-${generateId()}@example.com`,
            role: 'member',
          })
        ).user_id as UUID;
        await users.create({
          user_id: viewerId,
          email: `viewer-${generateId()}@example.com`,
          role: 'member',
        });
        const gitRepo = await repos.create({
          slug: `rbac-query-${generateId()}`,
          name: 'RBAC query regression',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/rbac-query.git',
          local_path: `/tmp/rbac-query-${generateId()}`,
          default_branch: 'main',
        });

        let unique = Math.floor(Math.random() * 100_000);
        const createPrivateBoardBranch = async (name: string, othersCan: 'none' | 'view') => {
          const board = await boards.create({
            name: `${name} board`,
            created_by: ownerId,
            access_mode: 'private',
          });
          const branch = await branches.create({
            branch_id: generateId() as BranchID,
            repo_id: gitRepo.repo_id,
            name,
            ref: name,
            path: `/tmp/rbac-query-${name}-${generateId()}`,
            branch_unique_id: unique++,
            created_by: ownerId,
            board_id: board.board_id,
            permission_source: 'override',
            others_can: othersCan,
          });
          return { board, branch };
        };

        const hidden = await createPrivateBoardBranch('hidden', 'none');
        const fallback = await createPrivateBoardBranch('fallback', 'view');
        const directOwner = await createPrivateBoardBranch('direct-owner', 'none');
        await branches.addOwner(directOwner.branch.branch_id, viewerId);

        const directGroup = await createPrivateBoardBranch('direct-group', 'none');
        const group = await groups.create({ name: 'Viewers', created_by: ownerId });
        await groups.addMember(group.group_id, viewerId, ownerId);
        await groups.upsertBranchGrant({
          branch_id: directGroup.branch.branch_id,
          group_id: group.group_id,
          can: 'session',
          created_by: ownerId,
        });

        const oldPrimaryBoard = await boards.create({
          name: 'Moved primary origin',
          created_by: ownerId,
          access_mode: 'private',
        });
        const currentPrimaryBoard = await boards.create({
          name: 'Moved primary destination',
          created_by: ownerId,
          access_mode: 'private',
        });
        const primary = await branches.create({
          branch_id: generateId() as BranchID,
          repo_id: gitRepo.repo_id,
          name: 'moved-primary',
          ref: 'moved-primary',
          path: `/tmp/rbac-query-primary-${generateId()}`,
          branch_unique_id: unique++,
          created_by: ownerId,
          board_id: oldPrimaryBoard.board_id,
          permission_source: 'override',
          others_can: 'none',
          custom_context: {
            teammate: { kind: 'teammate', displayName: 'Moved primary' },
          },
        });
        await boards.setPrimaryTeammate(oldPrimaryBoard.board_id, primary.branch_id);
        await branches.update(primary.branch_id, { board_id: currentPrimaryBoard.board_id });
        await branches.addOwner(primary.branch_id, viewerId);

        const sessionByBranch = new Map<string, string>();
        for (const branch of [
          hidden.branch,
          fallback.branch,
          directOwner.branch,
          directGroup.branch,
          primary,
        ]) {
          const session = await sessions.create({
            branch_id: branch.branch_id,
            created_by: ownerId,
            agentic_tool: 'claude-code',
          });
          sessionByBranch.set(branch.branch_id, session.session_id);
        }

        const accessibleBranchIds = new Set(
          (await branches.findAccessibleBranches(viewerId)).map((branch) => branch.branch_id)
        );
        expect(accessibleBranchIds).toEqual(
          new Set([
            fallback.branch.branch_id,
            directOwner.branch.branch_id,
            directGroup.branch.branch_id,
            primary.branch_id,
          ])
        );

        const visibleBoardIds = new Set(await boards.findVisibleBoardIds(viewerId));
        expect(visibleBoardIds).toEqual(
          new Set([
            fallback.board.board_id,
            directOwner.board.board_id,
            directGroup.board.board_id,
            oldPrimaryBoard.board_id,
            currentPrimaryBoard.board_id,
          ])
        );
        expect(visibleBoardIds.has(hidden.board.board_id)).toBe(false);
        expect(visibleBoardIds.has(foreignSharedBoardId)).toBe(false);

        const sessionPage = await sessions.findPage({
          visibleToUserId: viewerId,
          limit: 10,
          skip: 0,
        });
        expect(sessionPage.total).toBe(4);
        expect(new Set(sessionPage.data.map((session) => session.session_id))).toEqual(
          new Set(
            [fallback.branch, directOwner.branch, directGroup.branch, primary].map((branch) =>
              sessionByBranch.get(branch.branch_id)
            )
          )
        );
      });
    });
  }
);
