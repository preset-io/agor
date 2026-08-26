/** PostgreSQL/RLS + replica coverage for user/session secret resolution. */
import type { BranchID, SessionID, TenantID, UserID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../db/client';
import { executeRaw, isPostgresDatabase, select, update } from '../db/database-wrapper';
import { encryptApiKey, isEncrypted } from '../db/encryption';
import { initializeDatabase } from '../db/migrate';
import {
  BranchRepository,
  RepoRepository,
  SessionEnvSelectionRepository,
  SessionRepository,
  UsersRepository,
} from '../db/repositories';
import { users } from '../db/schema';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from '../db/tenant-scope';
import { generateId } from '../lib/ids';
import { resolveUserEnvironment } from './env-resolver';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 9_000_000;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'managed user environment resolution (PostgreSQL/RLS/replicas)',
  () => {
    let rawA: Database;
    let rawB: Database;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      if (!isPostgresDatabase(rawA) || !isPostgresDatabase(rawB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
      const [role] = rowsOf(
        await executeRaw(
          rawA,
          // The integration runner must exercise FORCE RLS as the application
          // role, never as a superuser/BYPASSRLS shortcut.
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      const policies = rowsOf(
        await executeRaw(
          rawA,
          sql`SELECT relname, relrowsecurity, relforcerowsecurity
              FROM pg_catalog.pg_class
              WHERE relname IN ('users', 'sessions', 'session_env_selections')`
        )
      );
      expect(policies).toHaveLength(3);
      for (const policy of policies) {
        expect(policy).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      }
    }, 60_000);

    afterAll(async () => {
      await Promise.all([
        (rawA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seed(tenantId: TenantID, label: string, secret: string) {
      const db = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: `env-resolver-${label}`,
      });
      return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${label}-${generateId()}@example.test`,
          name: label,
        });
        const row = await select(scoped).from(users).where(eq(users.user_id, user.user_id)).one();
        await update(scoped, users)
          .set({
            data: {
              ...(row?.data as Record<string, unknown>),
              env_vars: {
                GLOBAL_CANARY: {
                  value_encrypted: encryptApiKey(`${secret}-global`),
                  scope: 'global',
                },
                SESSION_CANARY: {
                  value_encrypted: encryptApiKey(`${secret}-session`),
                  scope: 'session',
                },
              },
            },
          })
          .where(eq(users.user_id, user.user_id))
          .run();
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: `${label}-${generateId()}`,
          name: label,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: label,
          ref: 'main',
          branch_unique_id: branchUnique++,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId() as SessionID,
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'codex',
          status: SessionStatus.IDLE,
        });
        await new SessionEnvSelectionRepository(scoped).add(session.session_id, 'SESSION_CANARY');
        return { userId: user.user_id as UserID, sessionId: session.session_id };
      });
    }

    it('keeps same-named values tenant/user/session bound across two connections', async () => {
      const tenantA = `env-a-${generateId()}` as TenantID;
      const tenantB = `env-b-${generateId()}` as TenantID;
      const a = await seed(tenantA, 'tenant-a', 'canary-a');
      const b = await seed(tenantB, 'tenant-b', 'canary-b');
      const dbA = createTenantScopedDatabaseProxy(rawA, { requireScope: true, label: 'env-a' });
      const replicaB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'env-replica-b',
      });

      await runWithTenantDatabaseScope(dbA, tenantA, async (scoped) => {
        expect(await resolveUserEnvironment(a.userId, scoped, { sessionId: a.sessionId })).toEqual({
          GLOBAL_CANARY: 'canary-a-global',
          SESSION_CANARY: 'canary-a-session',
        });
        expect(await resolveUserEnvironment(b.userId, scoped, { sessionId: b.sessionId })).toEqual(
          {}
        );
        // A foreign/hidden session ID cannot select A's same-named secret.
        expect(await resolveUserEnvironment(a.userId, scoped, { sessionId: b.sessionId })).toEqual({
          GLOBAL_CANARY: 'canary-a-global',
        });

        const row = await select(scoped).from(users).where(eq(users.user_id, a.userId)).one();
        expect(row).not.toBeNull();
        const stored = (row!.data as { env_vars: Record<string, { value_encrypted: string }> })
          .env_vars.SESSION_CANARY.value_encrypted;
        expect(isEncrypted(stored)).toBe(true);
        expect(JSON.stringify(row?.data)).not.toContain('canary-a-session');
      });

      await runWithTenantDatabaseScope(replicaB, tenantB, async (scoped) => {
        expect(await resolveUserEnvironment(b.userId, scoped, { sessionId: b.sessionId })).toEqual({
          GLOBAL_CANARY: 'canary-b-global',
          SESSION_CANARY: 'canary-b-session',
        });
        expect(await resolveUserEnvironment(a.userId, scoped, { sessionId: a.sessionId })).toEqual(
          {}
        );
      });
    });

    it('serializes selection replacement across replica connections', async () => {
      const tenantId = `env-replace-${generateId()}` as TenantID;
      const seeded = await seed(tenantId, 'replica-replace', 'replace-canary');
      const dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'env-replace-a',
      });
      const dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'env-replace-b',
      });

      await Promise.all([
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new SessionEnvSelectionRepository(scoped).setAll(seeded.sessionId, ['REPLICA_A'])
        ),
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new SessionEnvSelectionRepository(scoped).setAll(seeded.sessionId, ['REPLICA_B'])
        ),
      ]);

      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const names = await new SessionEnvSelectionRepository(scoped).listNames(seeded.sessionId);
        expect([['REPLICA_A'], ['REPLICA_B']]).toContainEqual(names);
      });
    });
  }
);
