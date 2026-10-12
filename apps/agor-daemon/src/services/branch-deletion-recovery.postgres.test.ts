import {
  BranchDeletionRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  generateId,
  initializeDatabase,
  rawRows,
  runWithTenantDatabaseScope,
  sql,
} from '@agor/core/db';
import { expect, it } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { exerciseDeletionRecovery } from '../../test/branch-deletion-recovery';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'recovers through PostgreSQL HTTP boundaries and fences in-flight transactions across replicas',
  async () => {
    const raw = createDatabase({ dialect: 'postgresql', url: url! });
    const peerRaw = createDatabase({ dialect: 'postgresql', url: url! });
    try {
      await initializeDatabase(raw);
      await exerciseDeletionRecovery(raw, 'postgresql');
      const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
      const peer = createTenantScopedDatabaseProxy(peerRaw, { requireScope: true });
      const tenant = `locking-${generateId()}`;
      const fixture = await runWithTenantDatabaseScope(db, tenant, async (tx) => {
        const { branch } = await seedEnvironmentCommandBranch(tx);
        const maintenance = new BranchMaintenanceRepository(tx);
        const { claim } = await maintenance.claim(branch.branch_id, 'delete');
        const invocation = await maintenance.beginExecution(claim);
        await maintenance.claimExecution(claim, invocation);
        return { branch, claim, invocation };
      });
      const { branch, claim, invocation } = fixture;
      await expect(
        runWithTenantDatabaseScope(peer, `foreign-${generateId()}`, (tx) =>
          new BranchDeletionRepository(tx).failSettled(claim, invocation, 'forged settlement')
        )
      ).rejects.toThrow('not found');
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        entered = resolve;
      });
      // An actual reference-page transaction remains open on replica A after
      // updating its cursor. Replica B must not release ownership before commit.
      const page = runWithTenantDatabaseScope(db, tenant, async (tx) => {
        await new BranchDeletionRepository(tx).quiescePage(claim, invocation);
        entered();
        await held;
      });
      await acquired;
      let settled = false;
      let settlementPid = 0;
      const settlement = runWithTenantDatabaseScope(peer, tenant, async (tx) => {
        settlementPid = Number(
          rawRows(await executeRaw(tx, sql`SELECT pg_backend_pid() AS pid`))[0]?.pid
        );
        await new BranchDeletionRepository(tx).failSettled(
          claim,
          invocation,
          'Stopped; retry available'
        );
      }).then(() => {
        settled = true;
      });
      try {
        // Observe an actual PostgreSQL lock wait, not just a slow JS promise.
        await expect
          .poll(async () => {
            if (!settlementPid) return false;
            const state = rawRows(
              await executeRaw(
                raw,
                sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${settlementPid}`
              )
            );
            return state[0]?.wait_event_type === 'Lock';
          })
          .toBe(true);
        expect(settled).toBe(false);
      } finally {
        release();
      }
      await Promise.all([page, settlement]);
      await runWithTenantDatabaseScope(peer, tenant, async (tx) => {
        const maintenance = new BranchMaintenanceRepository(tx);
        const retry = await maintenance.claim(branch.branch_id, 'delete');
        expect(retry.acquired).toBe(true);
        expect(retry.claim.generation).toBe(claim.generation + 1);
        // Old observer, delayed claim, DB callback and settlement cannot affect
        // replacement ownership, even after replacing the daemon application.
        await expect(maintenance.markStaleDeletion(claim, 1)).rejects.toThrow('ownership changed');
        await expect(maintenance.claimExecution(claim, invocation)).rejects.toThrow(
          'ownership changed'
        );
        await expect(
          new BranchDeletionRepository(tx).quiescePage(claim, invocation)
        ).rejects.toThrow('ownership changed');
        await expect(
          new BranchDeletionRepository(tx).failSettled(claim, invocation, 'stale')
        ).rejects.toThrow('ownership changed');
        expect((await new BranchRepository(tx).findById(branch.branch_id))?.deletion_status).toBe(
          'deleting'
        );
      });
    } finally {
      for (const connection of [raw, peerRaw])
        await (connection as unknown as { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  120_000
);
