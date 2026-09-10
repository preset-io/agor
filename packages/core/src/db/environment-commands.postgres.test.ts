import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { RepoEnvironment, TenantID } from '../types';
import { createDatabase, type Database } from './client';
import { update } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  EnvironmentCommandRepository,
  EnvironmentHealthDiscoveryRepository,
  RepoRepository,
} from './repositories';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { branches } from './schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'environment commands across PostgreSQL replicas and tenants',
  () => {
    let a: Database;
    let b: Database;
    beforeAll(async () => {
      a = createDatabase({ dialect: 'postgresql', url: url! });
      b = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(a);
    });
    afterAll(async () => {
      for (const db of [a, b])
        await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    it('replaces repository YAML across replicas without allowing foreign tenant writes', async () => {
      const tenant = `yaml-${generateId()}` as TenantID;
      const { branch } = await runWithTenantDatabaseScope(a, tenant, seedEnvironmentCommandBranch);
      const original: RepoEnvironment = {
        version: 2,
        default: 'keep',
        variants: {
          keep: { start: 'echo start', stop: 'echo stop', logs: 'echo old logs' },
          remove: { start: 'echo temporary', stop: 'echo stop' },
        },
      };
      await runWithTenantDatabaseScope(a, tenant, (db) =>
        new RepoRepository(db).setEnvironment(branch.repo_id, original)
      );
      const replacement: RepoEnvironment = {
        version: 2,
        default: 'keep',
        variants: { keep: { start: 'echo new', stop: 'echo stop' } },
      };
      await runWithTenantDatabaseScope(b, `foreign-${generateId()}` as TenantID, async (db) => {
        await expect(
          new RepoRepository(db).update(branch.repo_id, { environment: replacement })
        ).rejects.toThrow();
      });
      await runWithTenantDatabaseScope(a, tenant, async (db) => {
        expect((await new RepoRepository(db).findById(branch.repo_id))?.environment).toEqual(
          original
        );
      });
      await runWithTenantDatabaseScope(b, tenant, (db) =>
        new RepoRepository(db).update(branch.repo_id, {
          environment: replacement,
          name: 'YAML saved',
        })
      );
      await runWithTenantDatabaseScope(a, tenant, async (db) => {
        const saved = await new RepoRepository(db).findById(branch.repo_id);
        expect(saved?.environment).toEqual(replacement);
        expect(saved?.environment_config).toEqual({
          up_command: 'echo new',
          down_command: 'echo stop',
        });
        expect(saved?.name).toBe('YAML saved');
      });
    });

    it('legacy environment clears persist across replicas without crossing tenants', async () => {
      const tenant = `clear-${generateId()}` as TenantID;
      const { branch } = await runWithTenantDatabaseScope(a, tenant, seedEnvironmentCommandBranch);
      await runWithTenantDatabaseScope(a, tenant, (db) =>
        new BranchRepository(db).update(branch.branch_id, {
          environment_instance: { status: 'error', last_error: 'failed', process: { pid: 123 } },
          health_check_url: 'https://example.invalid/old-health',
          app_url: 'https://example.invalid/old-app',
        })
      );
      const clear = {
        health_check_url: undefined,
        app_url: undefined,
        environment_instance: {
          status: 'stopped' as const,
          process: undefined,
          last_error: undefined,
        },
      };
      await runWithTenantDatabaseScope(b, `foreign-${generateId()}` as TenantID, async (db) => {
        await expect(new BranchRepository(db).update(branch.branch_id, clear)).rejects.toThrow();
      });
      await runWithTenantDatabaseScope(a, tenant, async (db) => {
        const before = await new BranchRepository(db).findById(branch.branch_id);
        expect(before?.health_check_url).toBe('https://example.invalid/old-health');
        expect(before?.app_url).toBe('https://example.invalid/old-app');
        expect(
          (await new BranchRepository(db).findById(branch.branch_id))?.environment_instance
        ).toMatchObject({ last_error: 'failed', process: { pid: 123 } });
      });
      await runWithTenantDatabaseScope(b, tenant, (db) =>
        new BranchRepository(db).update(branch.branch_id, clear)
      );
      await runWithTenantDatabaseScope(a, tenant, async (db) => {
        const after = await new BranchRepository(db).findById(branch.branch_id);
        expect(after?.health_check_url).toBeUndefined();
        expect(after?.app_url).toBeUndefined();
        expect(after?.start_command).toBe(branch.start_command);
        expect(
          (await new BranchRepository(db).findById(branch.branch_id))?.environment_instance
        ).toEqual({ status: 'stopped' });
      });
    });

    it('admits and claims once, settles on another replica, rejects foreign tenants and stale confirmation', async () => {
      const tenant = `command-${generateId()}` as TenantID;
      const { branch, user } = await runWithTenantDatabaseScope(
        a,
        tenant,
        seedEnvironmentCommandBranch
      );
      const ids = [generateId(), generateId()];
      const admissions = await Promise.allSettled(
        [a, b].map((db, i) =>
          runWithTenantDatabaseScope(db, tenant, (scoped) =>
            new EnvironmentCommandRepository(scoped).admit({
              branch,
              userId: user.user_id,
              action: 'start',
              attemptId: ids[i]!,
            })
          )
        )
      );
      expect(admissions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const live = await runWithTenantDatabaseScope(b, tenant, (db) =>
        new BranchRepository(db).findById(branch.branch_id)
      );
      const scope = {
        branch_id: branch.branch_id,
        attempt_id: live!.environment_instance!.command_attempt!.id,
        action: 'start' as const,
      };
      const claims = await Promise.allSettled(
        [a, b].map((db) =>
          runWithTenantDatabaseScope(db, tenant, (scoped) =>
            new EnvironmentCommandRepository(scoped).report({ ...scope, kind: 'claim' })
          )
        )
      );
      expect(claims.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await runWithTenantDatabaseScope(b, `foreign-${generateId()}` as TenantID, async (db) => {
        expect(await new BranchRepository(db).findById(branch.branch_id)).toBeNull();
        await expect(
          new EnvironmentCommandRepository(db).report({
            ...scope,
            kind: 'result',
            outcome: 'succeeded',
            message: 'forged',
          })
        ).rejects.toThrow();
        await expect(
          new EnvironmentCommandRepository(db).admit({
            branch,
            userId: user.user_id,
            action: 'stop',
            attemptId: generateId(),
          })
        ).rejects.toThrow();
      });
      await runWithTenantDatabaseScope(b, tenant, async (db) => {
        const repository = new EnvironmentCommandRepository(db);
        const result = {
          ...scope,
          kind: 'result' as const,
          outcome: 'failed' as const,
          message: 'partial start',
        };
        await repository.report(result);
        expect(await repository.report({ ...result, outcome: 'succeeded' })).toMatchObject({
          status: 'error',
          last_command: { status: 'failed' },
        });
        await expect(
          repository.admit({
            branch,
            userId: user.user_id,
            action: 'start',
            attemptId: generateId(),
            confirmationOf: generateId(),
          })
        ).rejects.toThrow('cleanup is unconfirmed');
        await expect(
          repository.admit({
            branch,
            userId: user.user_id,
            action: 'start',
            attemptId: generateId(),
            confirmationOf: scope.attempt_id,
          })
        ).resolves.toMatchObject({ status: 'starting' });
      });
    });
    it('discovers stopping without an initiating request, then expires using the same application transition', async () => {
      const tenant = `lost-stop-${generateId()}` as TenantID;
      const { branch, user } = await runWithTenantDatabaseScope(
        a,
        tenant,
        seedEnvironmentCommandBranch
      );
      await runWithTenantDatabaseScope(a, tenant, async (db) => {
        const env = await new EnvironmentCommandRepository(db).admit({
          branch,
          action: 'stop',
          userId: user.user_id,
          attemptId: generateId(),
        });
        // Simulate the initiating replica disappearing and time passing, not a provider operation.
        env.command_attempt!.claim_deadline = new Date(0).toISOString();
        await update(db, branches)
          .set({ data: { ...branch, environment_instance: env } })
          .where(eq(branches.branch_id, branch.branch_id))
          .run();
      });
      const refs = await runWithSystemDatabaseScope(
        b,
        'environment_health_discovery',
        (db) => new EnvironmentHealthDiscoveryRepository(db).findActiveRefs({ limit: 1000 }),
        { capability: 'environment_health_discovery' }
      );
      expect(refs).toContainEqual({ tenant_id: tenant, branch_id: branch.branch_id });
      await runWithTenantDatabaseScope(b, tenant, async (db) => {
        expect(await new EnvironmentCommandRepository(db).expire(branch.branch_id)).toBe(true);
        expect(
          (await new BranchRepository(db).findById(branch.branch_id))?.environment_instance
        ).toMatchObject({ status: 'error', last_command: { status: 'unknown' } });
        await expect(
          new EnvironmentCommandRepository(db).admit({
            branch,
            action: 'stop',
            userId: user.user_id,
            attemptId: generateId(),
          })
        ).resolves.toMatchObject({ status: 'stopping' });
      });
    });
  }
);
