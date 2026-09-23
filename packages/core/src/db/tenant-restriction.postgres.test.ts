import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { TenantRestrictionCommand } from '../types/tenant-restriction';
import { createDatabase, type Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { EnvironmentCommandRepository } from './repositories/environment-commands';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { deleteTenantData } from './tenant-deletion';
import { buildTenantDeletionManifest } from './tenant-deletion-manifest';
import {
  NON_PORTABLE_TENANT_TABLES,
  tenantPortabilityTableNames,
} from './tenant-portability-manifest';
import {
  applyTenantRestrictionIntent,
  assertTenantExecutionAdmission,
  assertTenantUnrestricted,
  readTenantExecutionBoundary,
  readTenantRestrictionGeneration,
  readTenantRestrictionIntents,
  TenantRestrictedError,
  TenantRestrictionDataError,
  tenantRestrictionGenerationMatches,
} from './tenant-restriction';
import {
  createTenantScopedDatabaseProxy,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
} from './tenant-scope';
import { acquireTenantWriteGate, readTenantWriteGate } from './tenant-write-gate';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgres = process.env.AGOR_DB_DIALECT === 'postgresql';
const command = (patch: Partial<TenantRestrictionCommand> = {}): TenantRestrictionCommand => ({
  version: 1,
  controllerId: 'control-one',
  placementId: 'placement-one',
  operationId: 'suspend-one',
  revision: 1,
  action: 'restrict',
  ...patch,
});

async function close(db: Database) {
  await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
}

describe.skipIf(!postgresUrl || !usesPostgres)('tenant restriction intent (PostgreSQL)', () => {
  let db: Database;
  beforeAll(async () => {
    db = createDatabase({ url: postgresUrl! });
    await initializeDatabase(db);
    expect(isPostgresDatabase(db)).toBe(true);
  }, 60_000);
  afterAll(async () => {
    if (db) await close(db);
  });

  it('prepares missing history closed and fences delayed restriction and mismatched activation', async () => {
    const tenant = `restriction-missing-${generateId()}`;
    const release = command({ action: 'prepare_release', revision: 2, operationId: 'release-two' });
    expect((await applyTenantRestrictionIntent(db, tenant, release)).changed).toBe(true);
    await expect(assertTenantUnrestricted(db, tenant)).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    await expect(applyTenantRestrictionIntent(db, tenant, command())).rejects.toThrow();
    await expect(
      applyTenantRestrictionIntent(db, tenant, {
        ...release,
        action: 'activate',
        operationId: 'different-release',
      })
    ).rejects.toThrow();
    await expect(assertTenantUnrestricted(db, tenant)).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    await applyTenantRestrictionIntent(db, tenant, { ...release, action: 'activate' });
    await expect(assertTenantUnrestricted(db, tenant)).resolves.toBeUndefined();
  });

  it('binds minted work to a DB restriction epoch and orders a concurrent transition', async () => {
    const tenant = `restriction-generation-${generateId()}`;
    const guarded = createTenantScopedDatabaseProxy(db, {
      requireScope: true,
      label: 'generation',
    });
    let releaseMint!: () => void;
    let mintHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      mintHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    const minted = runWithTenantDatabaseTransaction(guarded, tenant, async (scoped) => {
      await assertTenantExecutionAdmission(scoped);
      const marker = await readTenantRestrictionGeneration(scoped, tenant);
      expect(marker).toBeNull();
      mintHeld();
      await release;
      return marker;
    });
    await held;
    const transition = applyTenantRestrictionIntent(db, tenant, command());
    // The transition cannot commit between a fenced generation read and its
    // corresponding widget insert/transaction commit.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await runWithTenantDatabaseScope(guarded, tenant, (scoped) =>
        readTenantRestrictionGeneration(scoped, tenant)
      )
    ).toBeNull();
    releaseMint();
    const oldMarker = await minted;
    await transition;
    await applyTenantRestrictionIntent(
      db,
      tenant,
      command({
        action: 'prepare_release',
        operationId: 'release-two',
        revision: 2,
      })
    );
    await applyTenantRestrictionIntent(
      db,
      tenant,
      command({
        action: 'activate',
        operationId: 'release-two',
        revision: 2,
      })
    );
    const newMarker = await runWithTenantDatabaseScope(guarded, tenant, (scoped) =>
      readTenantRestrictionGeneration(scoped, tenant)
    );
    expect(newMarker).toMatch(/^[a-f0-9]{64}$/);
    expect(tenantRestrictionGenerationMatches(oldMarker, newMarker)).toBe(false);
    expect(tenantRestrictionGenerationMatches(undefined, newMarker)).toBe(false);
    expect(tenantRestrictionGenerationMatches(newMarker, newMarker)).toBe(true);
  });

  it('persists through connection replacement; prepares closed, retains release watermark and rejects stale replay', async () => {
    const tenant = `restriction-${generateId()}`;
    await expect(assertTenantUnrestricted(db, tenant)).resolves.toBeUndefined();
    expect(await readTenantExecutionBoundary(db, tenant)).toEqual({ allowed: true });
    const first = await applyTenantRestrictionIntent(db, tenant, command());
    expect(first.changed).toBe(true);
    await expect(assertTenantUnrestricted(db, tenant)).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    const other = createDatabase({ url: postgresUrl! });
    try {
      expect(await readTenantRestrictionIntents(other, tenant)).toEqual([first.record]);
      expect((await applyTenantRestrictionIntent(other, tenant, command())).changed).toBe(false);
      const release = command({
        action: 'prepare_release',
        revision: 2,
        operationId: 'release-two',
      });
      await applyTenantRestrictionIntent(other, tenant, release);
      await expect(assertTenantUnrestricted(db, tenant)).rejects.toBeInstanceOf(
        TenantRestrictedError
      );
      await applyTenantRestrictionIntent(db, tenant, { ...release, action: 'activate' });
      await expect(assertTenantUnrestricted(other, tenant)).resolves.toBeUndefined();
      expect(await readTenantExecutionBoundary(other, tenant)).toEqual({
        allowed: true,
        resumeAfter: expect.any(Number),
      });
      expect((await applyTenantRestrictionIntent(other, tenant, release)).changed).toBe(false);
      await expect(applyTenantRestrictionIntent(other, tenant, command())).rejects.toThrow(
        'stale_revision'
      );
      expect(await readTenantRestrictionIntents(db, tenant)).toEqual([
        { ...first.record, operationId: 'release-two', revision: 2, phase: 'active' },
      ]);
    } finally {
      await close(other);
    }
  });

  it('fences environment start admission and old claims but preserves Stop settlement', async () => {
    const tenant = `environment-restriction-${generateId()}`;
    const seeded = await runWithTenantDatabaseScope(db, tenant, seedEnvironmentCommandBranch);
    const invoke = <T>(work: (commands: EnvironmentCommandRepository) => Promise<T>) =>
      runWithTenantDatabaseScope(db, tenant, (scoped) =>
        work(new EnvironmentCommandRepository(scoped))
      );
    const attemptId = generateId();
    const input = {
      branch: seeded.branch,
      userId: seeded.user.user_id,
      action: 'start' as const,
      attemptId,
    };
    await invoke((commands) => commands.admit(input));
    await applyTenantRestrictionIntent(db, tenant, command());
    await expect(
      invoke((commands) => commands.admit({ ...input, attemptId: generateId() }))
    ).rejects.toBeInstanceOf(TenantRestrictedError);
    const claim = {
      branch_id: seeded.branch.branch_id,
      attempt_id: attemptId,
      action: 'start' as const,
      kind: 'claim' as const,
    };
    await expect(invoke((commands) => commands.report(claim))).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    const release = command({ action: 'prepare_release', revision: 2, operationId: 'release-env' });
    await applyTenantRestrictionIntent(db, tenant, release);
    await applyTenantRestrictionIntent(db, tenant, { ...release, action: 'activate' });
    await expect(invoke((commands) => commands.report(claim))).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    // Retire the unclaimed command as unknown, not proof that its environment is absent.
    await invoke((commands) => commands.dispatchFailed(seeded.branch.branch_id, attemptId));
    await applyTenantRestrictionIntent(
      db,
      tenant,
      command({ revision: 3, operationId: 'restrict-again' })
    );
    const stopId = generateId();
    await invoke((commands) => commands.admit({ ...input, action: 'stop', attemptId: stopId }));
    const stop = { ...claim, attempt_id: stopId, action: 'stop' as const };
    await invoke((commands) => commands.report(stop));
    await expect(
      invoke((commands) =>
        commands.report({
          ...stop,
          kind: 'result',
          outcome: 'succeeded',
          message: 'stop command completed',
        })
      )
    ).resolves.toMatchObject({ status: 'stopped' });
  });

  it('owns a short tenant scope when passed the guarded daemon handle', async () => {
    const tenant = `restriction-${generateId()}`;
    const guarded = createTenantScopedDatabaseProxy(db);
    const first = await applyTenantRestrictionIntent(guarded, tenant, command());
    expect(await readTenantRestrictionIntents(guarded, tenant)).toEqual([first.record]);
    await expect(assertTenantUnrestricted(guarded, tenant)).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
  });

  it('serializes conflicting first writers and same-operation replay on an absent row', async () => {
    const tenant = `restriction-${generateId()}`;
    const results = await Promise.allSettled([
      applyTenantRestrictionIntent(db, tenant, command()),
      applyTenantRestrictionIntent(db, tenant, command({ operationId: 'competitor' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await readTenantRestrictionIntents(db, tenant)).toHaveLength(1);
    const replayTenant = `restriction-${generateId()}`;
    const replays = await Promise.all([
      applyTenantRestrictionIntent(db, replayTenant, command()),
      applyTenantRestrictionIntent(db, replayTenant, command()),
    ]);
    expect(replays.map((r) => r.changed).sort()).toEqual([false, true]);
  });

  it('seeds a re-home destination open at the watermark, once, and never repairs a recorded runtime', async () => {
    const seeded = `restriction-${generateId()}`;
    const seed = command({ action: 'seed_active', revision: 4, operationId: 'reactivate-four' });
    const written = await applyTenantRestrictionIntent(db, seeded, seed);
    expect(written).toMatchObject({ changed: true, record: { phase: 'active', revision: 4 } });
    await expect(assertTenantUnrestricted(db, seeded)).resolves.toBeUndefined();
    expect(await readTenantRestrictionIntents(db, seeded)).toEqual([written.record]);
    // An at-least-once transport replay of THIS seed is a no-op, not a conflict: the
    // row is untouched and the caller is told the truth instead of being handed a
    // failure for a runtime that is already correct.
    const replayed = await applyTenantRestrictionIntent(db, seeded, seed);
    expect(replayed).toEqual({ record: written.record, changed: false });
    expect(await readTenantRestrictionIntents(db, seeded)).toEqual([written.record]);
    // Every other recorded state still refuses it — the seed writes on empty history only.
    for (const patch of [
      { operationId: 'other-operation' },
      { revision: 5 },
      { placementId: 'placement-two' },
    ])
      await expect(
        applyTenantRestrictionIntent(db, seeded, command({ ...seed, ...patch }))
      ).rejects.toThrow('revision_conflict');
    expect(await readTenantRestrictionIntents(db, seeded)).toEqual([written.record]);
    // A CLOSED row at the seed's own revision is never reopened by a replay.
    const closed = `restriction-${generateId()}`;
    await applyTenantRestrictionIntent(db, closed, command({ revision: 4 }));
    await expect(applyTenantRestrictionIntent(db, closed, seed)).rejects.toThrow(
      'revision_conflict'
    );
    await expect(assertTenantUnrestricted(db, closed)).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    // A runtime that already recorded anything is never seeded open.
    const recorded = `restriction-${generateId()}`;
    await applyTenantRestrictionIntent(db, recorded, command());
    await expect(applyTenantRestrictionIntent(db, recorded, seed)).rejects.toThrow(
      'revision_conflict'
    );
    await expect(assertTenantUnrestricted(db, recorded)).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    // Concurrent seeds on one empty history: serialized by the advisory lock into
    // exactly one WRITE and one replay no-op, leaving exactly one row.
    const raced = `restriction-${generateId()}`;
    const results = await Promise.all([
      applyTenantRestrictionIntent(db, raced, seed),
      applyTenantRestrictionIntent(db, raced, seed),
    ]);
    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    expect(await readTenantRestrictionIntents(db, raced)).toMatchObject([{ phase: 'active' }]);
  });

  it('never lets release races reopen a newer restriction', async () => {
    const tenant = `restriction-${generateId()}`;
    await applyTenantRestrictionIntent(db, tenant, command());
    const release = command({ action: 'prepare_release', operationId: 'release-two', revision: 2 });
    await applyTenantRestrictionIntent(db, tenant, release);
    await Promise.allSettled([
      applyTenantRestrictionIntent(db, tenant, { ...release, action: 'activate' }),
      applyTenantRestrictionIntent(
        db,
        tenant,
        command({ operationId: 'suspend-three', revision: 3 })
      ),
    ]);
    expect(await readTenantRestrictionIntents(db, tenant)).toMatchObject([
      { phase: 'restricted', revision: 3 },
    ]);
    await expect(assertTenantUnrestricted(db, tenant)).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
  });

  it('composes controller restrictions without modifying the portability gate', async () => {
    const tenant = `restriction-${generateId()}`;
    const gate = await acquireTenantWriteGate(db, tenant);
    await applyTenantRestrictionIntent(db, tenant, command());
    await applyTenantRestrictionIntent(db, tenant, command({ controllerId: 'second-control' }));
    const release = command({ action: 'prepare_release', operationId: 'release-two', revision: 2 });
    await applyTenantRestrictionIntent(db, tenant, release);
    await applyTenantRestrictionIntent(db, tenant, { ...release, action: 'activate' });
    await expect(assertTenantUnrestricted(db, tenant)).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    expect(await readTenantWriteGate(db, tenant)).toMatchObject({
      active: true,
      generation: gate.generation,
    });
  });

  it('enforces RLS against cross-tenant reads, changes, and forged inserts; scoped helper cannot switch tenant', async () => {
    const a = `restriction-${generateId()}`;
    const b = `restriction-${generateId()}`;
    await applyTenantRestrictionIntent(db, a, command());
    await expect(assertTenantUnrestricted(db, b)).resolves.toBeUndefined();
    await runWithTenantDatabaseScope(db, b, async (scoped) => {
      expect(
        await executeRaw(
          scoped,
          sql`SELECT * FROM public.tenant_restrictions WHERE tenant_id = ${a}`
        )
      ).toHaveLength(0);
      expect(
        await executeRaw(
          scoped,
          sql`UPDATE public.tenant_restrictions SET phase = 'active' WHERE tenant_id = ${a} RETURNING *`
        )
      ).toHaveLength(0);
      await expect(readTenantRestrictionIntents(scoped, a)).rejects.toThrow();
    });
    await expect(
      runWithTenantDatabaseScope(db, b, (scoped) =>
        executeRaw(
          scoped,
          sql`
      INSERT INTO public.tenant_restrictions (tenant_id, controller_id, placement_id, operation_id, revision, phase)
      VALUES (${a}, 'forged', 'p', 'o', 1, 'active')
    `
        )
      )
    ).rejects.toThrow();
    await expect(assertTenantUnrestricted(db, a)).rejects.toBeInstanceOf(TenantRestrictedError);
    await expect(
      applyTenantRestrictionIntent(db, a, command({ placementId: 'wrong-placement', revision: 2 }))
    ).rejects.toThrow('identity_mismatch');
    expect(await readTenantRestrictionIntents(db, a)).toHaveLength(1);
  });

  it('rolls back on transaction failure and rejects corrupt persisted authority', async () => {
    const tenant = `restriction-${generateId()}`;
    await expect(
      runWithTenantDatabaseScope(db, tenant, async (scoped) => {
        await applyTenantRestrictionIntent(scoped, tenant, command());
        throw new Error('rollback-fixture');
      })
    ).rejects.toThrow('rollback-fixture');
    expect(await readTenantRestrictionIntents(db, tenant)).toEqual([]);
    await applyTenantRestrictionIntent(db, tenant, command());
    await runWithTenantDatabaseScope(db, tenant, (scoped) =>
      executeRaw(
        scoped,
        sql`
      UPDATE public.tenant_restrictions SET phase = 'unknown' WHERE tenant_id = ${tenant}
    `
      )
    );
    await expect(assertTenantUnrestricted(db, tenant)).rejects.toBeInstanceOf(
      TenantRestrictionDataError
    );
    await expect(
      applyTenantRestrictionIntent(db, tenant, command({ revision: 2 }))
    ).rejects.toBeInstanceOf(TenantRestrictionDataError);
  });

  it('requires explicit tenant scope even for default and denies system scopes', async () => {
    const c = command({ controllerId: `default-${generateId()}` });
    await applyTenantRestrictionIntent(db, 'default', c);
    expect(
      await executeRaw(
        db,
        sql`SELECT * FROM public.tenant_restrictions WHERE controller_id = ${c.controllerId}`
      )
    ).toHaveLength(0);
    await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
      await executeRaw(
        scoped,
        sql`SELECT set_config('agor.system_scope', 'unrelated_operator', true)`
      );
      expect(
        await executeRaw(
          scoped,
          sql`SELECT * FROM public.tenant_restrictions WHERE controller_id = ${c.controllerId}`
        )
      ).toHaveLength(0);
      await expect(assertTenantUnrestricted(scoped, 'default')).rejects.toBeInstanceOf(
        TenantRestrictionDataError
      );
      await expect(applyTenantRestrictionIntent(scoped, 'default', c)).rejects.toBeInstanceOf(
        TenantRestrictionDataError
      );
    });
    await expect(
      runWithSystemDatabaseScope(db, 'restriction-test', (scoped) =>
        assertTenantUnrestricted(scoped, 'default')
      )
    ).rejects.toThrow('Cannot enter tenant scope');
    await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
      await executeRaw(scoped, sql`SELECT set_config('agor.tenant_id', 'different', true)`);
      await expect(assertTenantUnrestricted(scoped, 'default')).rejects.toBeInstanceOf(
        TenantRestrictionDataError
      );
    });
  });

  it('erases only the selected tenant restriction rows through the audited deletion engine', async () => {
    const a = `restriction-${generateId()}`;
    const b = `restriction-${generateId()}`;
    await applyTenantRestrictionIntent(db, a, command());
    await applyTenantRestrictionIntent(db, b, command());
    await deleteTenantData(db, a);
    expect(await readTenantRestrictionIntents(db, a)).toEqual([]);
    expect(await readTenantRestrictionIntents(db, b)).toHaveLength(1);
  });

  it('is tenant-owned for erasure but does not export deployment-bound controller authority', () => {
    expect(
      buildTenantDeletionManifest().some((entry) => entry.name === 'tenant_restrictions')
    ).toBe(true);
    expect(NON_PORTABLE_TENANT_TABLES.has('tenant_restrictions')).toBe(true);
    expect(tenantPortabilityTableNames()).not.toContain('tenant_restrictions');
  });
});
