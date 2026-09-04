import {
  BranchRepository,
  CapabilityPolicyRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import {
  type BranchID,
  capabilityPolicyPresetCapabilities,
  type Session,
  SessionStatus,
  type TenantID,
  type User,
} from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupCapabilityPolicyServices } from './capability-policies.js';
import { type SessionParams, SessionsService } from './sessions.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = Date.now() % 1_000_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function params(actor: User, tenantId: TenantID, branchId?: BranchID): SessionParams {
  return {
    provider: 'rest',
    user: { user_id: actor.user_id, email: actor.email, role: actor.role },
    tenant: { tenant_id: tenantId, source: 'auth_claim' },
    ...(branchId && { route: { id: branchId } }),
  } as SessionParams;
}

function archiveApp(events: Session[]): Application {
  return {
    get(key: string) {
      return key === 'config'
        ? { execution: { branch_rbac: true, allow_superadmin: false } }
        : undefined;
    },
    service: () => ({
      emit(event: string, session: Session) {
        if (event === 'patched') events.push(session);
      },
    }),
  } as unknown as Application;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Sessions archive authority and concurrency (PostgreSQL/RLS)',
  () => {
    let rawA: Database;
    let rawB: Database;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'sessions-archive-postgres-a',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'sessions-archive-postgres-b',
      });
    }, 60_000);

    afterAll(async () => {
      await Promise.all([
        (rawA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seed(tenantId: TenantID, label: string) {
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const users = new UsersRepository(scoped);
        const owner = await users.create({
          email: `${label}-owner-${generateId()}@example.invalid`,
          role: 'member',
        });
        const actor = await users.create({
          email: `${label}-actor-${generateId()}@example.invalid`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: `${label}-${generateId()}`,
          name: label,
          repo_type: 'remote',
          remote_url: `https://example.invalid/${label}.git`,
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: label,
          ref: 'main',
          branch_unique_id: branchUnique++,
          path: `/tmp/${generateId()}`,
          created_by: owner.user_id,
          others_can: 'prompt',
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
          created_by: owner.user_id,
        });
        return { owner, actor, branch, session };
      });
    }

    it('observes a branch permission revocation that wins the tenant authority fence', async () => {
      const tenantId = `archive-authority-${generateId()}` as TenantID;
      const { owner, actor, branch, session } = await seed(tenantId, 'archive-authority');
      const policyApp = feathers();
      setupCapabilityPolicyServices(policyApp, dbA);
      const policyService = policyApp.service('branches/:id/permissions');
      const current = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new CapabilityPolicyRepository(scoped).getBranchPolicy(branch.branch_id)
      );
      const revoked = structuredClone(current);
      revoked.override_config!.access.others = {
        preset: 'viewer',
        capabilities: capabilityPolicyPresetCapabilities('branch_access', 'viewer') ?? [],
        fs_access: 'none',
      };
      const revokedBeforeCommit = deferred();
      const releaseRevocation = deferred();

      const revocation = runWithTenantDatabaseTransaction(dbA, tenantId, async () => {
        const saved = await policyService.patch(
          null,
          revoked,
          params(owner, tenantId, branch.branch_id) as never
        );
        revokedBeforeCommit.resolve();
        await releaseRevocation.promise;
        return saved;
      });
      await revokedBeforeCommit.promise;

      let archiveSettled = false;
      const archive = new SessionsService(dbB, archiveApp([]))
        .archive(session.session_id, { includeChildren: false }, params(actor, tenantId))
        .finally(() => {
          archiveSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(archiveSettled).toBe(false);
      releaseRevocation.resolve();

      await expect(revocation).resolves.toMatchObject({
        override_config: { access: { others: { preset: 'viewer' } } },
      });
      await expect(archive).rejects.toMatchObject({ code: 403 });
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        await expect(
          new SessionRepository(scoped).findById(session.session_id)
        ).resolves.toMatchObject({ archived: false });
      });
    }, 10_000);

    it('serializes identical archive writes into one durable change and event', async () => {
      const tenantId = `archive-row-lock-${generateId()}` as TenantID;
      const { session } = await seed(tenantId, 'archive-row-lock');
      const events: Session[] = [];
      const serviceA = new SessionsService(dbA, archiveApp(events));
      const serviceB = new SessionsService(dbB, archiveApp(events));
      const firstChanged = deferred();
      const releaseFirst = deferred();

      const first = runWithTenantDatabaseTransaction(dbA, tenantId, async () => {
        try {
          const result = await serviceA.archive(
            session.session_id,
            { includeChildren: false, includeRemoteChildren: false },
            { tenant: { tenant_id: tenantId, source: 'service' } } as SessionParams
          );
          firstChanged.resolve();
          await releaseFirst.promise;
          return result;
        } finally {
          firstChanged.resolve();
        }
      });
      let second!: Promise<Awaited<ReturnType<SessionsService['archive']>>>;
      try {
        await firstChanged.promise;
        expect(events).toEqual([]);

        let secondSettled = false;
        second = serviceB
          .archive(session.session_id, { includeChildren: false, includeRemoteChildren: false }, {
            tenant: { tenant_id: tenantId, source: 'service' },
          } as SessionParams)
          .finally(() => {
            secondSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondSettled).toBe(false);
      } finally {
        releaseFirst.resolve();
      }

      await expect(first).resolves.toMatchObject({ count: 1, archivedCount: 1 });
      await expect(second).resolves.toMatchObject({ count: 0, archivedCount: 0 });
      expect(events.map((event) => event.session_id)).toEqual([session.session_id]);
      await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        await expect(
          new SessionRepository(scoped).findById(session.session_id)
        ).resolves.toMatchObject({ archived: true, archived_reason: 'manual' });
      });
    }, 10_000);
  }
);
