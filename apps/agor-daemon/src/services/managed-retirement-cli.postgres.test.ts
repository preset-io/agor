/** Production CLI helper boundary, actual non-owner PostgreSQL; no provider or external database. */
import { randomUUID } from 'node:crypto';
import {
  acquireTenantWriteGate,
  inspectTenantWriteGate,
  releaseTenantWriteGate,
  runWithTenantDatabaseScope,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedManagedRefreshGrant } from '../../../../packages/core/src/db/test-support/managed-oauth-fixture';
import {
  createOwnedPostgres,
  type OwnedPostgres,
} from '../../../../packages/core/src/db/test-support/owned-postgres';
import {
  beginManagedCellRetirement,
  executeManagedRetirement,
  listManagedRetirementTargets,
} from '../../../agor-cli/src/lib/managed-oauth-retirement';

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed lifecycle CLI non-owner authority',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    it('reports actual counts, never releases the gate, and rejects stale or foreign gate proofs', async () => {
      const seeded = await seedManagedRefreshGrant(owned.db, 'synthetic-cli-master-secret');
      const gate = await acquireTenantWriteGate(owned.db, seeded.tenant);
      const input = {
        tenant_id: seeded.tenant,
        gate_generation: gate.generation,
        operation_id: randomUUID(),
      };
      const before = await executeManagedRetirement(owned.db, input, false);
      expect(before).toMatchObject({
        version: 1,
        ...input,
        ready: false,
        active_grants: 1,
        pending_cleanup: 0,
      });
      const retired = await executeManagedRetirement(owned.db, input, true);
      expect(retired).toMatchObject({ version: 1, ...input, ready: false, active_grants: 0 });
      expect(retired.pending_cleanup).toBeGreaterThan(0);
      expect(await executeManagedRetirement(owned.db, input, true)).toEqual(retired);
      expect(await inspectTenantWriteGate(owned.db, seeded.tenant)).toMatchObject({
        active: true,
        generation: gate.generation,
      });
      await expect(
        executeManagedRetirement(owned.db, { ...input, tenant_id: 'foreign-tenant' }, true)
      ).rejects.toThrow();
      await expect(
        executeManagedRetirement(owned.db, { ...input, gate_generation: randomUUID() }, false)
      ).rejects.toThrow();
      const targets = await listManagedRetirementTargets(owned.db, undefined, 100);
      expect(targets.tenant_ids).toContain(seeded.tenant);
      await releaseTenantWriteGate(owned.db, seeded.tenant, { generation: gate.generation });
      await expect(executeManagedRetirement(owned.db, input, false)).rejects.toThrow();
    });
    it('pins the configured deployment and exact immutable cell barrier on target enumeration', async () => {
      const cell = { cell_id: 'cell', operation_id: randomUUID() };
      const gate = await beginManagedCellRetirement(owned.db, cell, 'cell');
      expect(gate).toEqual({ version: 1, ...cell, gate_generation: expect.any(String) });
      expect(await beginManagedCellRetirement(owned.db, cell, 'cell')).toEqual(gate);
      await expect(beginManagedCellRetirement(owned.db, cell, 'foreign-cell')).rejects.toThrow();
      await expect(
        beginManagedCellRetirement(owned.db, { ...cell, operation_id: randomUUID() }, 'cell')
      ).rejects.toThrow();
      await expect(
        listManagedRetirementTargets(owned.db, undefined, 100, gate, 'cell')
      ).resolves.toMatchObject({ version: 1 });
      await expect(
        listManagedRetirementTargets(
          owned.db,
          undefined,
          100,
          { ...gate, gate_generation: randomUUID() },
          'cell'
        )
      ).rejects.toThrow();
      await expect(
        listManagedRetirementTargets(
          owned.db,
          undefined,
          100,
          { ...gate, cell_id: 'missing-cell' },
          'missing-cell'
        )
      ).rejects.toThrow();
      await expect(
        seedManagedRefreshGrant(owned.db, 'synthetic-cli-master-secret')
      ).rejects.toThrow();
    });
    it('forwards the exact cell fence without retiring foreign-cell grants in a shared logical database', async () => {
      const tenant = `shared-${randomUUID()}`;
      const a = await seedManagedRefreshGrant(
        owned.db,
        'synthetic-cli-master-secret',
        tenant,
        'cell-a'
      );
      const b = await seedManagedRefreshGrant(
        owned.db,
        'synthetic-cli-master-secret',
        tenant,
        'cell-b'
      );
      const foreign = await seedManagedRefreshGrant(
        owned.db,
        'synthetic-cli-master-secret',
        undefined,
        'cell-b'
      );
      const fence = await beginManagedCellRetirement(
        owned.db,
        { cell_id: 'cell-a', operation_id: randomUUID() },
        'cell-a'
      );
      const gate = await acquireTenantWriteGate(owned.db, tenant);
      const input = {
        tenant_id: tenant,
        gate_generation: gate.generation,
        operation_id: randomUUID(),
      };
      const filtered = await listManagedRetirementTargets(
        owned.db,
        undefined,
        100,
        fence,
        'cell-a'
      );
      expect(filtered.tenant_ids).toContain(tenant);
      expect(filtered.tenant_ids).not.toContain(foreign.tenant);
      await expect(executeManagedRetirement(owned.db, input, false)).resolves.toMatchObject({
        active_grants: 2,
      });
      await expect(
        executeManagedRetirement(owned.db, input, false, fence, 'cell-a')
      ).resolves.toMatchObject({ active_grants: 1 });
      await expect(
        executeManagedRetirement(
          owned.db,
          input,
          true,
          { ...fence, gate_generation: randomUUID() },
          'cell-a'
        )
      ).rejects.toThrow();
      await expect(
        executeManagedRetirement(owned.db, input, true, fence, 'cell-a')
      ).resolves.toMatchObject({ active_grants: 0, ready: false });
      await expect(executeManagedRetirement(owned.db, input, false)).resolves.toMatchObject({
        active_grants: 1,
      });
      await runWithTenantDatabaseScope(owned.db, tenant, async (db) => {
        const repo = new UserMCPOAuthTokenRepository(db);
        expect(await repo.getManagedMetadata(a.user, a.server)).toBeUndefined();
        expect(await repo.getManagedMetadata(b.user, b.server)).toEqual(b.commit.metadata);
      });
    });
  }
);
