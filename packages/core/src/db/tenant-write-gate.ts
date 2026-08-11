/**
 * Generic, runtime-owned per-tenant write gate.
 *
 * An external orchestrator that needs a tenant's data to hold still — to export,
 * verify, migrate, or delete it — records an intent to stop writers and can
 * prove that intent stayed continuous. This module provides that primitive
 * without any deployment-specific knowledge: it knows only a tenant id, a
 * database connection, and an opaque, monotonic *generation* token.
 *
 * What this is (and is NOT):
 *
 *   This is APP-LAYER, fail-closed enforcement. The gate record is consulted at
 *   the request hooks and the deferred operator helpers wired to
 *   {@link assertTenantWritable} (see `register-hooks.ts` `writeGateBefore`,
 *   `utils/tenant-db-scope.ts`, `utils/session-queue-tenant-scope.ts`). It is
 *   NOT a database lock or fence. It does not stop a write that already passed
 *   its pre-acquire check before the gate row appeared, and it does not stop a
 *   raw writer that bypasses those entry points entirely — such a write can
 *   still commit while the gate is "held". The gate therefore makes quiescence
 *   *enforceable at the wired boundaries*, not an affirmative freeze of every
 *   possible writer. Export/verify/delete consistency ultimately RELIES on the
 *   mandatory `verify` step, which re-hashes live tenant data against the
 *   archive and detects any straggler write. True writer fencing (e.g. DB-level
 *   triggers that reject writes while the gate row exists) is deliberately left
 *   as future hardening.
 *
 * Semantics:
 *
 *   - **Acquire** writes a gate record stamped with a fresh generation (a
 *     time-ordered UUIDv7). While the record exists, tenant writes fail closed
 *     at the wired enforcement points (see {@link assertTenantWritable}).
 *   - **Generation binding** lets a holder prove the *same* gate remained in
 *     force. A later acquire mints a new generation (replacement); a release
 *     removes it (loss). Either makes a continuity check for the old generation
 *     fail — the fail-closed contract the orchestrator relies on.
 *   - **Release** removes the gate, but only for the generation the caller holds
 *     (compare-and-delete), so one operator cannot lift another's gate.
 *   - **In-transaction assertion** ({@link assertTenantWriteGateGeneration}) lets
 *     a destructive operation confirm, inside its own transaction, that the gate
 *     is still held at the expected generation before it commits. This binds the
 *     DATABASE deletion phase only; a subsequent filesystem deletion is a
 *     separate step and is not covered by this assertion.
 *
 * The gate record is stored as a single reserved key in the tenant-owned
 * `app_variables` table, so it is row-level-security isolated per tenant and is
 * removed automatically when the tenant is deleted — no dedicated schema. Gate
 * state is PostgreSQL-only, mirroring the rest of Agor's multi-tenancy: on the
 * single-tenant SQLite schema there is nothing to gate, and enforcement is a
 * no-op so it never blocks a self-hosted developer.
 */

import { sql } from 'drizzle-orm';
import { generateId } from '../lib/ids';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import { runWithTenantDatabaseScope } from './tenant-scope';

/** Reserved `app_variables` coordinates for the write-gate record. */
export const TENANT_WRITE_GATE_NAMESPACE = 'agor:tenant-write-gate';
export const TENANT_WRITE_GATE_KEY = 'state';

/**
 * Repository method-name prefixes that only read. Everything else is treated as
 * a write so the tenant unit-of-work boundary ({@link
 * bindRepositoryToTenantUnitOfWork}) enforces the gate on any mutator, including
 * one whose name this list does not anticipate — fail closed, never fail open.
 * A read whose name is not recognised is only over-gated while a freeze is
 * actually held (a no-op otherwise), so the conservative default costs nothing
 * in steady state.
 */
const READ_METHOD_PREFIXES = [
  'get',
  'find',
  'list',
  'count',
  'exists',
  'has',
  'is',
  'can',
  'resolve',
  'search',
  'lookup',
  'read',
  'load',
  'fetch',
  'query',
  'enrich',
  'scan',
  'neighbors',
] as const;

/**
 * Classify a repository method name as a write (gated) or a read (never gated),
 * the shared basis for enforcing the write gate at the tenant unit-of-work
 * boundary. Fail closed: a name that matches no read prefix is a write. Compound
 * mutators that begin with a read-ish verb (e.g. `getOrCreateNode`) are writes.
 */
export function isTenantWriteMethodName(name: string): boolean {
  if (/^getOr[A-Z]/.test(name)) return true;
  for (const prefix of READ_METHOD_PREFIXES) {
    if (name === prefix) return false;
    // Match a camelCase boundary so `get` matches `getFoo` but not `getaway`.
    if (
      name.length > prefix.length &&
      name.startsWith(prefix) &&
      name[prefix.length] === name[prefix.length].toUpperCase()
    ) {
      return false;
    }
  }
  return true;
}

/** Thrown by enforcement when a tenant write is attempted during a freeze. */
export class TenantWriteGateActiveError extends Error {
  readonly tenantId: string;
  readonly generation: string | undefined;
  constructor(tenantId: string, generation: string | undefined) {
    super(`Tenant ${tenantId} is write-gated; writes are blocked until the gate is released`);
    this.name = 'TenantWriteGateActiveError';
    this.tenantId = tenantId;
    this.generation = generation;
  }
}

/** Thrown when acquiring a gate that is already held (without `force`). */
export class TenantWriteGateHeldError extends Error {
  readonly tenantId: string;
  readonly generation: string;
  constructor(tenantId: string, generation: string) {
    super(`Tenant ${tenantId} is already write-gated (generation ${generation})`);
    this.name = 'TenantWriteGateHeldError';
    this.tenantId = tenantId;
    this.generation = generation;
  }
}

/** Thrown when the live gate generation does not match the expected one. */
export class TenantWriteGateGenerationError extends Error {
  readonly tenantId: string;
  readonly expected: string;
  readonly actual: string | undefined;
  constructor(tenantId: string, expected: string, actual: string | undefined) {
    super(
      `Tenant ${tenantId} write-gate generation mismatch: expected ${expected}, ` +
        `found ${actual ?? 'no active gate'}`
    );
    this.name = 'TenantWriteGateGenerationError';
    this.tenantId = tenantId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Thrown when a gate operation targets a non-PostgreSQL (single-tenant) database. */
export class TenantWriteGateUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantWriteGateUnsupportedError';
  }
}

/** Bounded, secret-free description of a tenant's write gate. */
export interface TenantWriteGateState {
  active: boolean;
  generation?: string;
  acquiredAt?: string;
  holder?: string;
  reason?: string;
}

const TENANT_SCHEMA = 'public';
const APP_VARIABLES_TABLE = 'app_variables';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function appVariablesTable() {
  return sql`${sql.identifier(TENANT_SCHEMA)}.${sql.identifier(APP_VARIABLES_TABLE)}`;
}

/**
 * Take a per-tenant, transaction-scoped PostgreSQL advisory lock so that gate
 * mutations for one tenant serialize even when NO gate row exists yet.
 *
 * `SELECT ... FOR UPDATE` locks an existing row, but at READ COMMITTED there is
 * no gap/predicate lock: when the gate row is absent, two concurrent initial
 * acquires can both observe null and both "succeed" (the second's
 * `INSERT ... ON CONFLICT DO UPDATE` silently overwrites the first). The
 * advisory lock closes that empty-state race by serializing on a stable key
 * derived from the gate namespace and the tenant id, so the check-then-act is
 * atomic against a concurrent acquire/release on the same tenant. It is held
 * until the surrounding transaction commits (`_xact_` variant).
 *
 * Only the mutation paths ({@link acquireTenantWriteGate} /
 * {@link releaseTenantWriteGate}) take it; the read-only enforcement path
 * ({@link assertTenantWritable}) stays lock-free so reads never block. The
 * destructive generation assertion ({@link assertTenantWriteGateGeneration}) does
 * not take the advisory lock: it always finds an existing gate row and locks it
 * with `FOR UPDATE`, which alone serializes a concurrent release/acquire through
 * its transaction.
 */
async function lockTenantGateMutation(scopedDb: Database, tenantId: string): Promise<void> {
  const lockKey = `${TENANT_WRITE_GATE_NAMESPACE}:${tenantId}`;
  await executeRaw(
    scopedDb,
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`
  );
}

interface GatePayload {
  generation: string;
  acquiredAt: string;
  holder?: string;
  reason?: string;
}

function parseGatePayload(valueText: unknown): GatePayload | null {
  if (typeof valueText !== 'string' || valueText.length === 0) return null;
  try {
    const parsed = JSON.parse(valueText) as Partial<GatePayload>;
    if (typeof parsed.generation !== 'string' || parsed.generation.length === 0) return null;
    return {
      generation: parsed.generation,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
      ...(typeof parsed.holder === 'string' ? { holder: parsed.holder } : {}),
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Read the gate record using a database handle already scoped to the tenant
 * (the caller owns the transaction). Returns null when no gate is present.
 */
async function readGateRowScoped(
  scopedDb: Database,
  tenantId: string
): Promise<GatePayload | null> {
  const result = await executeRaw(
    scopedDb,
    sql`
      SELECT value_text
      FROM ${appVariablesTable()}
      WHERE tenant_id = ${tenantId}
        AND namespace = ${TENANT_WRITE_GATE_NAMESPACE}
        AND key = ${TENANT_WRITE_GATE_KEY}
      LIMIT 1
    `
  );
  return parseGatePayload(rowsOf(result)[0]?.value_text);
}

/**
 * Read the gate record for update, taking a row lock (`FOR UPDATE`) on the gate
 * row WHEN IT EXISTS. This serializes a check-then-act against a concurrent
 * acquire/release only for the row-exists case: `FOR UPDATE` locks a matched
 * row, but at READ COMMITTED it takes NO lock when the row is absent (there is
 * no gap/predicate lock), so it does not by itself serialize two initial
 * acquires racing from an empty gate. The empty-state race is closed separately
 * by {@link lockTenantGateMutation} (a per-tenant advisory lock the mutation
 * paths take first). Used by {@link acquireTenantWriteGate},
 * {@link releaseTenantWriteGate}, and the destructive
 * {@link assertTenantWriteGateGeneration} — which relies on the row lock to keep
 * a source gate continuously held through its deletion commit. The cheap
 * read-only enforcement paths ({@link readTenantWriteGate} /
 * {@link assertTenantWritable}) stay unlocked so enforcement reads never block.
 * The caller owns the transaction (the surrounding tenant scope), so the lock is
 * held until that transaction commits.
 */
async function readGateRowScopedForUpdate(
  scopedDb: Database,
  tenantId: string
): Promise<GatePayload | null> {
  const result = await executeRaw(
    scopedDb,
    sql`
      SELECT value_text
      FROM ${appVariablesTable()}
      WHERE tenant_id = ${tenantId}
        AND namespace = ${TENANT_WRITE_GATE_NAMESPACE}
        AND key = ${TENANT_WRITE_GATE_KEY}
      LIMIT 1
      FOR UPDATE
    `
  );
  return parseGatePayload(rowsOf(result)[0]?.value_text);
}

function toState(payload: GatePayload | null): TenantWriteGateState {
  if (!payload) return { active: false };
  return {
    active: true,
    generation: payload.generation,
    acquiredAt: payload.acquiredAt,
    ...(payload.holder ? { holder: payload.holder } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
  };
}

/**
 * Read a tenant's write-gate state. On the single-tenant SQLite schema there is
 * no gate, so this always reports inactive (enforcement never blocks).
 */
export async function readTenantWriteGate(
  db: Database,
  tenantId: string
): Promise<TenantWriteGateState> {
  if (!isPostgresDatabase(db)) return { active: false };
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) =>
    toState(await readGateRowScoped(scoped, tenantId))
  );
}

/**
 * Fail closed if the tenant is currently write-gated. This is the enforcement
 * primitive wired into tenant write entry points. It is a no-op on SQLite and
 * when no gate is active.
 */
export async function assertTenantWritable(db: Database, tenantId: string): Promise<void> {
  const state = await readTenantWriteGate(db, tenantId);
  if (state.active) {
    throw new TenantWriteGateActiveError(tenantId, state.generation);
  }
}

export interface AcquireTenantWriteGateOptions {
  /** Free-form label identifying the operator that acquired the gate. */
  holder?: string;
  /** Free-form reason recorded for audit. */
  reason?: string;
  /** Replace an existing gate, minting a new generation, instead of refusing. */
  force?: boolean;
}

export interface AcquireTenantWriteGateResult {
  generation: string;
  /** The generation replaced when `force` supplanted an existing gate. */
  replacedGeneration?: string;
}

function assertPostgres(db: Database, action: string): void {
  if (!isPostgresDatabase(db)) {
    throw new TenantWriteGateUnsupportedError(
      `Tenant write gate ${action} requires a PostgreSQL (multi-tenant) database; the SQLite schema is single-tenant`
    );
  }
}

/**
 * Acquire (freeze) the tenant write gate, minting a fresh generation. Refuses if
 * a gate is already active unless `force` is set, in which case the existing gate
 * is replaced by a new generation (which a prior holder's continuity check will
 * detect). PostgreSQL-only.
 */
export async function acquireTenantWriteGate(
  db: Database,
  tenantId: string,
  options: AcquireTenantWriteGateOptions = {}
): Promise<AcquireTenantWriteGateResult> {
  assertPostgres(db, 'acquire');
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    // Serialize this acquire against a concurrent acquire/release on the same
    // tenant BEFORE reading. The per-tenant advisory lock is what makes the
    // empty-gate case safe: two non-force acquires racing from "no gate" would
    // both observe null under `FOR UPDATE` alone (which cannot lock an absent
    // row at READ COMMITTED) and both succeed; with the advisory lock the loser
    // blocks, then sees the winner's row and rejects.
    await lockTenantGateMutation(scoped, tenantId);
    // Locking read: also lock the gate row for the row-exists case.
    const existing = await readGateRowScopedForUpdate(scoped, tenantId);
    if (existing && !options.force) {
      throw new TenantWriteGateHeldError(tenantId, existing.generation);
    }
    const generation = generateId();
    const payload: GatePayload = {
      generation,
      acquiredAt: new Date().toISOString(),
      ...(options.holder ? { holder: options.holder } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    };
    const variableId = generateId();
    const valueText = JSON.stringify(payload);
    await executeRaw(
      scoped,
      sql`
        INSERT INTO ${appVariablesTable()}
          (variable_id, tenant_id, namespace, key, value_text, is_encrypted, content_type, created_at, updated_at)
        VALUES (
          ${variableId}, ${tenantId}, ${TENANT_WRITE_GATE_NAMESPACE}, ${TENANT_WRITE_GATE_KEY},
          ${valueText}, false, 'application/json', pg_catalog.now(), pg_catalog.now()
        )
        ON CONFLICT (tenant_id, namespace, key)
        DO UPDATE SET value_text = EXCLUDED.value_text, updated_at = pg_catalog.now()
      `
    );
    return {
      generation,
      ...(existing ? { replacedGeneration: existing.generation } : {}),
    };
  });
}

export interface InspectTenantWriteGateOptions {
  /** When provided, also report whether the gate is held at this generation. */
  expectGeneration?: string;
}

export interface TenantWriteGateInspection extends TenantWriteGateState {
  /**
   * Present only when `expectGeneration` was supplied: true iff the gate is
   * active at exactly that generation (the "held continuously" proof).
   */
  heldContinuously?: boolean;
}

/**
 * Inspect the tenant write gate, optionally checking that it is still held at a
 * specific generation (fail-closed continuity: inactive or a different
 * generation both yield `heldContinuously: false`). PostgreSQL-only.
 */
export async function inspectTenantWriteGate(
  db: Database,
  tenantId: string,
  options: InspectTenantWriteGateOptions = {}
): Promise<TenantWriteGateInspection> {
  assertPostgres(db, 'inspect');
  const state = await readTenantWriteGate(db, tenantId);
  if (options.expectGeneration === undefined) return state;
  return {
    ...state,
    heldContinuously: state.active && state.generation === options.expectGeneration,
  };
}

export interface ReleaseTenantWriteGateOptions {
  /** The generation the caller holds; the gate is removed only if it matches. */
  generation: string;
  /** Remove the gate even if the generation differs (records `forced`). */
  force?: boolean;
}

export interface ReleaseTenantWriteGateResult {
  released: boolean;
  reason: 'released' | 'forced' | 'not-active';
}

/**
 * Release (unfreeze) the tenant write gate. Removes the gate only when the live
 * generation matches the caller's, unless `force` is set. Absent gate is an
 * idempotent no-op success. PostgreSQL-only.
 */
export async function releaseTenantWriteGate(
  db: Database,
  tenantId: string,
  options: ReleaseTenantWriteGateOptions
): Promise<ReleaseTenantWriteGateResult> {
  assertPostgres(db, 'release');
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    // Serialize against a concurrent acquire/release on the same tenant before
    // deciding. Same rationale as acquire: the advisory lock covers the case
    // where the row does not exist (`FOR UPDATE` cannot lock an absent row), so
    // a release cannot interleave with a concurrent first acquire.
    await lockTenantGateMutation(scoped, tenantId);
    // Locking read: take the row lock before deciding, so no concurrent
    // acquire/release can change the generation between this read and the delete.
    const existing = await readGateRowScopedForUpdate(scoped, tenantId);
    if (!existing) return { released: false, reason: 'not-active' };
    if (existing.generation !== options.generation && !options.force) {
      throw new TenantWriteGateGenerationError(tenantId, options.generation, existing.generation);
    }
    // Predicate the delete on the exact generation observed under the lock, so
    // we remove only that record — a defense-in-depth compare-and-delete that
    // cannot drop a replacement generation even if the lock were absent.
    await executeRaw(
      scoped,
      sql`
        DELETE FROM ${appVariablesTable()}
        WHERE tenant_id = ${tenantId}
          AND namespace = ${TENANT_WRITE_GATE_NAMESPACE}
          AND key = ${TENANT_WRITE_GATE_KEY}
          AND (value_text::pg_catalog.jsonb->>'generation') = ${existing.generation}
      `
    );
    const forced = existing.generation !== options.generation;
    return { released: true, reason: forced ? 'forced' : 'released' };
  });
}

/**
 * Assert, using a database handle already scoped to the tenant's transaction,
 * that the write gate is active at exactly `generation`. Throws otherwise. Used
 * by destructive operations to bind their commit to a continuously-held source
 * gate. The caller must already be inside the tenant transaction.
 *
 * The read takes `FOR UPDATE` on the gate row (via {@link
 * readGateRowScopedForUpdate}) rather than a bare read. This is the load-bearing
 * difference from ordinary {@link assertTenantWritable}: the destructive caller
 * proceeds to delete inside the SAME transaction, so holding the row lock from
 * assertion through commit means a concurrent release or forced re-acquire — both
 * of which lock the gate row before mutating it — blocks until this transaction
 * commits and cannot slip a replacement generation in between the check and the
 * destructive commit. Ordinary enforcement reads stay lock-free so they never
 * block; only this generation assertion is serialized.
 *
 * Deadlock ordering: this assertion takes the gate-row lock FIRST, then the
 * destructive plan takes its table locks; acquire/release take the per-tenant
 * advisory lock, then the gate-row lock. The destructive path never waits on the
 * advisory lock, so no lock-order cycle exists — a blocked acquire/release simply
 * waits for the destructive commit.
 */
export async function assertTenantWriteGateGeneration(
  scopedDb: Database,
  tenantId: string,
  generation: string
): Promise<void> {
  const existing = await readGateRowScopedForUpdate(scopedDb, tenantId);
  if (!existing || existing.generation !== generation) {
    throw new TenantWriteGateGenerationError(tenantId, generation, existing?.generation);
  }
}
