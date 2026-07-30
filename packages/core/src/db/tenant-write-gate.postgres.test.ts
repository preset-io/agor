/**
 * PostgreSQL integration for the tenant write gate — real RLS-scoped acquire /
 * inspect / release, generation replacement and loss, and binding destructive
 * deletion to a continuously-held gate. Gated on an explicit test database,
 * mirroring the repository PostgreSQL suites; skipped in the SQLite fast-lane CI.
 *
 * Run with, e.g.:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/tenant-write-gate.postgres.test.ts
 */

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { UUID } from '../types/id';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase, select } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { BranchRepository } from './repositories/branches';
import { RepoRepository } from './repositories/repos';
import { SessionRepository } from './repositories/sessions';
import * as pg from './schema.postgres';
import { deleteTenantData } from './tenant-deletion';
import { runWithTenantDatabaseScope } from './tenant-scope';
import {
  acquireTenantWriteGate,
  assertTenantWritable,
  inspectTenantWriteGate,
  releaseTenantWriteGate,
  TenantWriteGateActiveError,
  TenantWriteGateGenerationError,
  TenantWriteGateHeldError,
} from './tenant-write-gate';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

let branchUniqueSeq = Date.now() % 1_000_000;

async function seedTenant(db: Database, tenantId: string): Promise<void> {
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const repoId = generateId();
    await new RepoRepository(scoped).create({
      repo_id: repoId,
      slug: `wg-${tenantId}-${repoId}`,
      name: `repo ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/write-gate.git',
      local_path: `/tmp/${repoId}`,
      default_branch: 'main',
    });
    const branchId = generateId();
    await new BranchRepository(scoped).create({
      branch_id: branchId,
      repo_id: repoId,
      name: `branch-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchUniqueSeq++,
      path: `/tmp/${branchId}`,
      created_by: 'write-gate-test-user' as UUID,
    });
    await new SessionRepository(scoped).create({
      session_id: generateId(),
      branch_id: branchId,
      agentic_tool: 'claude-code',
      created_by: 'write-gate-test-user',
    });
  });
}

async function closePostgresDatabase(db: Database): Promise<void> {
  await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
}

async function countTenantSessions(db: Database, tenantId: string): Promise<number> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const rows = (await select(scoped, { n: count() })
      .from(pg.sessions)
      .where(eq(pg.sessions.tenant_id, tenantId))
      .all()) as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('tenant write gate (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
  });

  afterAll(async () => {
    await closePostgresDatabase(db);
  });

  it('blocks writers while held and clears on release', async () => {
    const tenant = `wg-${generateId()}`;
    await seedTenant(db, tenant);

    // No gate: writable.
    await expect(assertTenantWritable(db, tenant)).resolves.toBeUndefined();

    const { generation } = await acquireTenantWriteGate(db, tenant, {
      holder: 'test',
      reason: 'freeze',
    });
    expect(generation).toBeTruthy();

    // Held: enforcement fails closed.
    await expect(assertTenantWritable(db, tenant)).rejects.toBeInstanceOf(
      TenantWriteGateActiveError
    );

    // Continuity holds at the acquired generation.
    const held = await inspectTenantWriteGate(db, tenant, { expectGeneration: generation });
    expect(held.active).toBe(true);
    expect(held.heldContinuously).toBe(true);

    // Release clears the gate; writers pass again.
    const released = await releaseTenantWriteGate(db, tenant, { generation });
    expect(released.released).toBe(true);
    expect(released.reason).toBe('released');
    await expect(assertTenantWritable(db, tenant)).resolves.toBeUndefined();

    // Releasing again is an idempotent no-op.
    const again = await releaseTenantWriteGate(db, tenant, { generation });
    expect(again.released).toBe(false);
    expect(again.reason).toBe('not-active');

    await deleteTenantData(db, tenant);
  });

  it('detects replacement and refuses double-acquire without force', async () => {
    const tenant = `wg-${generateId()}`;
    await seedTenant(db, tenant);

    const first = await acquireTenantWriteGate(db, tenant);
    // A second acquire without force is refused.
    await expect(acquireTenantWriteGate(db, tenant)).rejects.toBeInstanceOf(
      TenantWriteGateHeldError
    );

    // Forced re-acquire mints a new generation (replacement).
    const second = await acquireTenantWriteGate(db, tenant, { force: true });
    expect(second.generation).not.toBe(first.generation);
    expect(second.replacedGeneration).toBe(first.generation);

    // The old generation's continuity check now fails closed (replacement).
    const stale = await inspectTenantWriteGate(db, tenant, { expectGeneration: first.generation });
    expect(stale.active).toBe(true);
    expect(stale.heldContinuously).toBe(false);

    // Releasing with the stale generation is refused; the current one works.
    await expect(
      releaseTenantWriteGate(db, tenant, { generation: first.generation })
    ).rejects.toBeInstanceOf(TenantWriteGateGenerationError);
    const released = await releaseTenantWriteGate(db, tenant, { generation: second.generation });
    expect(released.released).toBe(true);

    await deleteTenantData(db, tenant);
  });

  it('release is generation-predicated: stale refused, forced re-acquire rotates', async () => {
    const tenant = `wg-${generateId()}`;
    await seedTenant(db, tenant);

    const first = await acquireTenantWriteGate(db, tenant);
    // Forced re-acquire mints a new generation atomically (locking read + upsert).
    const second = await acquireTenantWriteGate(db, tenant, { force: true });
    expect(second.generation).not.toBe(first.generation);

    // A release holding the superseded generation is refused (compare-and-delete):
    // the generation-predicated DELETE never drops the replacement generation.
    await expect(
      releaseTenantWriteGate(db, tenant, { generation: first.generation })
    ).rejects.toBeInstanceOf(TenantWriteGateGenerationError);

    // The gate is still held at the current generation.
    const held = await inspectTenantWriteGate(db, tenant, { expectGeneration: second.generation });
    expect(held.active).toBe(true);
    expect(held.heldContinuously).toBe(true);

    // Releasing the current generation clears it.
    const released = await releaseTenantWriteGate(db, tenant, { generation: second.generation });
    expect(released.released).toBe(true);
    expect(released.reason).toBe('released');
    const after = await inspectTenantWriteGate(db, tenant);
    expect(after.active).toBe(false);

    await deleteTenantData(db, tenant);
  });

  it('binds destructive deletion to the held gate generation', async () => {
    const tenant = `wg-${generateId()}`;
    await seedTenant(db, tenant);

    const { generation } = await acquireTenantWriteGate(db, tenant);

    // Deletion asserting a mismatched generation aborts and deletes nothing.
    await expect(
      deleteTenantData(db, tenant, { assertGateGeneration: 'not-the-held-generation' })
    ).rejects.toBeInstanceOf(TenantWriteGateGenerationError);
    expect(await countTenantSessions(db, tenant)).toBe(1);

    // Deletion asserting the correct generation succeeds (and removes the gate).
    const result = await deleteTenantData(db, tenant, { assertGateGeneration: generation });
    expect(result.tenantDataDeleted).toBe(true);
    expect(await countTenantSessions(db, tenant)).toBe(0);

    // Gate is gone with the tenant.
    const after = await inspectTenantWriteGate(db, tenant);
    expect(after.active).toBe(false);
  });
});
