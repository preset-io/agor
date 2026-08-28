/**
 * Real 0094 -> 0095 RBAC owner-backfill proof using only the integration
 * runner's disposable PostgreSQL database.
 */

import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardID, BranchID, TenantID, UserID } from '@agor/core/types';
import { sql } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { createDatabase, type Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import { runMigrations } from './migrate';
import { CapabilityPolicyRepository } from './repositories/capability-policies';
import { GroupRepository } from './repositories/groups';
import { RepoRepository } from './repositories/repos';
import { UsersRepository } from './repositories/users';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');

function rows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> } | undefined)?.rows ?? []) as Array<
    Record<string, unknown>
  >;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'RBAC owner quarantine migration (PostgreSQL)',
  () => {
    let db: Database | null = null;
    let pre0095Folder: string | null = null;
    const tenantA = 'rbac-owner-migration-a' as TenantID;
    const tenantB = 'rbac-owner-migration-b' as TenantID;
    const sensitiveBoardId = generateId() as BoardID;
    const sensitiveBranchId = generateId() as BranchID;
    const foreignSensitiveBoardId = generateId() as BoardID;
    let memberId!: UserID;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');

      pre0095Folder = await mkdtemp(join(tmpdir(), 'agor-pg-migrations-through-0094-'));
      await cp(migrationsFolder, pre0095Folder, { recursive: true });
      await unlink(join(pre0095Folder, '0095_board_branch_capability_policies.sql'));
      const journalPath = join(pre0095Folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ idx: number }>;
      };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 94);
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migratePostgres(db as never, { migrationsFolder: pre0095Folder });

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const users = new UsersRepository(scoped);
        memberId = (
          await users.create({
            email: `rbac-owner-member-${generateId()}@example.test`,
            role: 'member',
          })
        ).user_id as UserID;
        const owner = await users.create({
          email: `rbac-owner-valid-${generateId()}@example.test`,
          role: 'member',
        });
        const manager = await users.create({
          email: `rbac-owner-manager-${generateId()}@example.test`,
          role: 'member',
        });
        const group = await new GroupRepository(scoped).create({
          name: `RBAC migration ${generateId()}`,
          created_by: owner.user_id,
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `rbac-owner-migration-${generateId()}`,
          name: 'RBAC owner migration',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/rbac-owner-migration.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const validBoardId = generateId();
        const validBranchId = generateId();

        await executeRaw(
          scoped,
          sql`INSERT INTO boards (
                tenant_id,board_id,created_at,updated_at,created_by,name,slug,data,archived
              ) VALUES
              (${tenantA},${validBoardId},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,${owner.user_id},
               'Valid legacy board',${`valid-${validBoardId}`},
               '{"access_mode":"shared","default_others_can":"prompt","default_others_fs_access":"write"}'::jsonb,false),
              (${tenantA},${sensitiveBoardId},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'anonymous',
               'Sensitive orphan board',${`orphan-${sensitiveBoardId}`},
               '{"access_mode":"shared","default_others_can":"all","default_others_fs_access":"write"}'::jsonb,false)`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO board_owners (tenant_id,board_id,user_id,created_at) VALUES
                (${tenantA},${validBoardId},${owner.user_id},CURRENT_TIMESTAMP),
                (${tenantA},${validBoardId},${manager.user_id},CURRENT_TIMESTAMP)`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO board_group_grants
                (tenant_id,board_id,group_id,"can",fs_access,created_at,updated_at) VALUES
                (${tenantA},${validBoardId},${group.group_id},'all','write',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
                (${tenantA},${sensitiveBoardId},${group.group_id},'all','write',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO branches (
                tenant_id,branch_id,repo_id,created_at,updated_at,created_by,name,ref,ref_type,
                branch_unique_id,board_id,needs_attention,archived,permission_source,
                others_can,others_fs_access,storage_mode,data
              ) VALUES
              (${tenantA},${validBranchId},${repo.repo_id},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
               ${owner.user_id},'valid-legacy','valid-legacy','branch',810001,${validBoardId},true,false,
               'override','prompt','write','worktree','{"path":"/tmp/valid","new_branch":false}'::jsonb),
              (${tenantA},${sensitiveBranchId},${repo.repo_id},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
               'missing-user','sensitive-orphan','sensitive-orphan','branch',810002,${sensitiveBoardId},true,false,
               'override','all','write','worktree','{"path":"/tmp/orphan","new_branch":false}'::jsonb)`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO branch_owners (tenant_id,branch_id,user_id,created_at) VALUES
                (${tenantA},${validBranchId},${owner.user_id},CURRENT_TIMESTAMP),
                (${tenantA},${validBranchId},${manager.user_id},CURRENT_TIMESTAMP)`
        );
        await executeRaw(
          scoped,
          sql`INSERT INTO branch_group_grants
                (tenant_id,branch_id,group_id,"can",fs_access,created_at,updated_at) VALUES
                (${tenantA},${validBranchId},${group.group_id},'prompt','write',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
                (${tenantA},${sensitiveBranchId},${group.group_id},'all','write',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
        );
      });

      // A second non-default tenant proves the temporary migration policy is
      // database-wide and is removed again after the cutover.
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        await executeRaw(
          scoped,
          sql`INSERT INTO boards (
                tenant_id,board_id,created_at,updated_at,created_by,name,slug,data,archived
              ) VALUES (
                ${tenantB},${foreignSensitiveBoardId},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
                'anonymous','Foreign sensitive orphan',${`orphan-${foreignSensitiveBoardId}`},
                '{"access_mode":"shared"}'::jsonb,false
              )`
        );
      });

      await runMigrations(db, { allowOfflineCutover: true });
    });

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
      if (pre0095Folder) await rm(pre0095Folder, { recursive: true, force: true });
    });

    it('preserves attributable access and privately quarantines every tenant owner miss', async () => {
      if (!db) throw new Error('PostgreSQL test database was not initialized');

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const ownerRows = rows(
          await executeRaw(
            scoped,
            sql`SELECT
                  (SELECT primary_owner_user_id FROM boards WHERE board_id=${sensitiveBoardId}) AS board_owner,
                  (SELECT primary_owner_user_id FROM branches WHERE branch_id=${sensitiveBranchId}) AS branch_owner`
          )
        );
        expect(ownerRows[0]).toEqual({ board_owner: null, branch_owner: null });

        const policyRows = rows(
          await executeRaw(
            scoped,
            sql`SELECT p.sharing_mode,p.others_role,c.sharing_mode AS branch_sharing,
                       c.others_role AS branch_others,c.others_fs_access
                FROM board_access_policies p
                JOIN branch_permission_configs c
                  ON c.tenant_id=p.tenant_id AND c.branch_id=${sensitiveBranchId}
                WHERE p.board_id=${sensitiveBoardId}`
          )
        );
        expect(policyRows[0]).toMatchObject({
          sharing_mode: 'private',
          others_role: 'none',
          branch_sharing: 'private',
          branch_others: 'none',
          others_fs_access: 'none',
        });
        const quarantinedEntries = rows(
          await executeRaw(
            scoped,
            sql`SELECT
                  (SELECT count(*)::int FROM board_access_entries
                   WHERE board_id=${sensitiveBoardId}) AS board_count,
                  (SELECT count(*)::int FROM branch_permission_entries e
                   JOIN branch_permission_configs c
                     ON c.tenant_id=e.tenant_id AND c.config_id=e.config_id
                   WHERE c.branch_id=${sensitiveBranchId}) AS branch_count`
          )
        );
        expect(quarantinedEntries[0]).toEqual({ board_count: 0, branch_count: 0 });

        const access = await new CapabilityPolicyRepository(scoped).resolveBranchAccess(
          sensitiveBranchId,
          memberId
        );
        expect(access).toMatchObject({
          capabilities: [],
          fs_access: 'none',
          is_primary_owner: false,
        });

        const preserved = rows(
          await executeRaw(
            scoped,
            sql`SELECT
                  (SELECT count(*)::int FROM board_access_entries WHERE role='manager') AS board_managers,
                  (SELECT count(*)::int FROM branch_permission_entries WHERE role IN ('collaborator','manager')) AS branch_workers`
          )
        );
        expect(Number(preserved[0]?.board_managers)).toBeGreaterThan(0);
        expect(Number(preserved[0]?.branch_workers)).toBeGreaterThan(0);
      });

      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const migrated = rows(
          await executeRaw(
            scoped,
            sql`SELECT b.primary_owner_user_id,p.sharing_mode,p.others_role
                FROM boards b JOIN board_access_policies p
                  ON p.tenant_id=b.tenant_id AND p.board_id=b.board_id
                WHERE b.board_id=${foreignSensitiveBoardId}`
          )
        );
        expect(migrated[0]).toEqual({
          primary_owner_user_id: null,
          sharing_mode: 'private',
          others_role: 'none',
        });

        const crossTenant = rows(
          await executeRaw(
            scoped,
            sql`SELECT board_id FROM boards WHERE board_id=${sensitiveBoardId}`
          )
        );
        expect(crossTenant).toEqual([]);
      });

      const temporaryPolicies = rows(
        await executeRaw(
          db,
          sql`SELECT tablename,policyname FROM pg_policies
              WHERE policyname='rbac_migration_0095_all_tenants'`
        )
      );
      expect(temporaryPolicies).toEqual([]);
    });
  }
);
