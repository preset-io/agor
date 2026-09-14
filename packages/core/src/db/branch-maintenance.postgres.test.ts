import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchID, UserID } from '../types';
import { admitTeammateKnowledgeReferences } from './branch-reference-admission';
import { createDatabase } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { runMigrations } from './migrate';
import { BranchDeletionRepository } from './repositories/branch-deletion';
import { BranchMaintenanceRepository } from './repositories/branch-maintenance';
import { BranchRepository } from './repositories/branches';
import { KnowledgeNamespaceRepository } from './repositories/knowledge';
import { RepoRepository } from './repositories/repos';
import { UsersRepository } from './repositories/users';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { acquireTenantWriteGate, releaseTenantWriteGate } from './tenant-write-gate';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'fences maintenance claims, failures and invocation settlement by tenant',
  async () => {
    // The suite runner creates one disposable database per test file.
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    try {
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await runMigrations(db, { allowOfflineCutover: true });
      const tenantA = `maintenance-a-${generateId()}`;
      const tenantB = `maintenance-b-${generateId()}`;
      let namespaceId = '';
      const claim = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const owner = generateId() as UserID;
        await new UsersRepository(scoped).create({
          user_id: owner,
          email: `${owner}@example.invalid`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: 'maintenance',
          name: 'Fixture',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo',
          local_path: '/disposable/not-created',
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: 'fixture',
          ref: 'fixture',
          branch_unique_id: 1,
          path: '/disposable/not-created/fixture',
          created_by: owner,
        });
        namespaceId = (
          await new KnowledgeNamespaceRepository(scoped).create({
            slug: 'owned-deletion',
            kind: 'branch',
            branch_id: branch.branch_id,
          })
        ).namespace_id;
        return (await new BranchMaintenanceRepository(scoped).claim(branch.branch_id, 'delete'))
          .claim;
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        await expect(
          admitTeammateKnowledgeReferences(scoped, {
            teammate: { kb: { primary_namespace_id: namespaceId } },
          })
        ).rejects.toThrow('unavailable');
        const maintenance = new BranchMaintenanceRepository(scoped);
        expect(await new BranchRepository(scoped).findById(claim.branch_id)).toBeNull();
        await expect(maintenance.claim(claim.branch_id, 'delete')).rejects.toThrow('not found');
        await expect(maintenance.fail(claim, 'forged failure')).rejects.toThrow('not found');
        await expect(maintenance.settleExecution(claim, generateId())).rejects.toThrow('not found');
        await expect(maintenance.claimExecution(claim, generateId())).rejects.toThrow('not found');
        await expect(maintenance.heartbeatExecution(claim, generateId())).rejects.toThrow(
          'not found'
        );
        await expect(maintenance.markStaleDeletion(claim, 30_000)).rejects.toThrow('not found');
        await expect(
          maintenance.withExecution(claim, generateId(), async () => {
            throw new Error('Foreign tenant reached deletion transaction');
          })
        ).rejects.toThrow('not found');
      });
      const gate = await acquireTenantWriteGate(db, tenantA, { reason: 'disposable fixture' });
      try {
        await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
          await expect(
            new BranchMaintenanceRepository(scoped).beginExecution(claim)
          ).rejects.toThrow();
        });
      } finally {
        await releaseTenantWriteGate(db, tenantA, { generation: gate.generation });
      }
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const maintenance = new BranchMaintenanceRepository(scoped);
        const execution = await maintenance.beginExecution(claim);
        await maintenance.claimExecution(claim, execution);
        await maintenance.heartbeatExecution(claim, execution);
        expect(await maintenance.markStaleDeletion(claim, 30_000)).toBe(false);
        expect(await maintenance.withExecution(claim, execution, async () => true)).toBe(true);
        await maintenance.settleExecution(claim, execution);
        await maintenance.fail(claim, 'Removal failed; retry is available.');
        expect(await new BranchRepository(scoped).findById(claim.branch_id)).toMatchObject({
          deletion_status: 'deletion_failed',
          deletion_error: 'Removal failed; retry is available.',
        });
      });
      const retry = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const maintenance = new BranchMaintenanceRepository(scoped);
        const { claim: retryClaim } = await maintenance.claim(claim.branch_id, 'delete');
        const execution = await maintenance.beginExecution(retryClaim);
        await maintenance.claimExecution(retryClaim, execution);
        return { claim: retryClaim, execution };
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const deletion = new BranchDeletionRepository(scoped);
        await expect(deletion.verifyStorage(retry.claim, retry.execution)).rejects.toThrow(
          'not found'
        );
        await expect(deletion.deleteDataPage(retry.claim, retry.execution)).rejects.toThrow(
          'not found'
        );
        await expect(
          deletion.finalize(retry.claim, retry.execution, async () => {})
        ).rejects.toThrow('not found');
      });
      // Independent pool: both pages visit the other Branch while holding their
      // subject lock. Tenant reference serialization must precede either lock.
      const peerDb = createDatabase({ dialect: 'postgresql', url: url! });
      try {
        const peer = await runWithTenantDatabaseScope(peerDb, tenantA, async (scoped) => {
          const source = (await new BranchRepository(scoped).findById(retry.claim.branch_id))!;
          const branch = await new BranchRepository(scoped).create({
            branch_id: generateId() as BranchID,
            repo_id: source.repo_id,
            name: 'peer',
            ref: 'peer',
            branch_unique_id: 2,
            path: '/disposable/peer',
            created_by: source.created_by,
          });
          const maintenance = new BranchMaintenanceRepository(scoped);
          const { claim } = await maintenance.claim(branch.branch_id, 'delete');
          const execution = await maintenance.beginExecution(claim);
          await maintenance.claimExecution(claim, execution);
          return { claim, execution };
        });
        for (let page = 0; page < 10; page++) {
          await Promise.all([
            runWithTenantDatabaseScope(db, tenantA, (scoped) =>
              new BranchDeletionRepository(scoped).quiescePage(retry.claim, retry.execution)
            ),
            runWithTenantDatabaseScope(peerDb, tenantA, (scoped) =>
              new BranchDeletionRepository(scoped).quiescePage(peer.claim, peer.execution)
            ),
          ]);
        }
      } finally {
        await (peerDb as typeof peerDb & { $client: { end(): Promise<void> } }).$client.end();
      }
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const deletion = new BranchDeletionRepository(scoped);
        await deletion.verifyStorage(retry.claim, retry.execution); // database-only disposable fixture
        for (let page = 0; ; page++) {
          expect(page).toBeLessThan(30);
          if (!(await deletion.deleteDataPage(retry.claim, retry.execution)).remaining) break;
        }
        await deletion.finalize(retry.claim, retry.execution, async () => {});
        expect(await new BranchRepository(scoped).findById(claim.branch_id)).toBeNull();
      });
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  60_000
);
