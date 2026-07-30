/**
 * Generic, runtime-owned per-tenant write gate.
 *
 * An external orchestrator that needs a tenant's data to hold still — to export,
 * verify, migrate, or delete it — must be able to stop every writer for that
 * tenant and prove the stop was continuous. This module provides that primitive
 * without any deployment-specific knowledge: it knows only a tenant id, a
 * database connection, and an opaque, monotonic *generation* token.
 *
 * Semantics:
 *
 *   - **Acquire** freezes a tenant by writing a gate record stamped with a fresh
 *     generation (a time-ordered UUIDv7). While the record exists, tenant writes
 *     fail closed at the enforcement points (see {@link assertTenantWritable}).
 *   - **Generation binding** lets a holder prove the *same* freeze remained in
 *     force. A later acquire mints a new generation (replacement); a release
 *     removes it (loss). Either makes a continuity check for the old generation
 *     fail — the fail-closed contract the orchestrator relies on.
 *   - **Release** removes the gate, but only for the generation the caller holds
 *     (compare-and-delete), so one operator cannot lift another's freeze.
 *   - **In-transaction assertion** ({@link assertTenantWriteGateGeneration}) lets
 *     a destructive operation confirm, inside its own transaction, that the gate
 *     is still held at the expected generation before it commits.
 *
 * The gate record is stored as a single reserved key in the tenant-owned
 * `app_variables` table, so it is row-level-security isolated per tenant and is
 * removed automatically when the tenant is deleted — no dedicated schema. Gate
 * state is PostgreSQL-only, mirroring the rest of Agor's multi-tenancy: on the
 * single-tenant SQLite schema there is nothing to freeze, and enforcement is a
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
    const existing = await readGateRowScoped(scoped, tenantId);
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
    const existing = await readGateRowScoped(scoped, tenantId);
    if (!existing) return { released: false, reason: 'not-active' };
    if (existing.generation !== options.generation && !options.force) {
      throw new TenantWriteGateGenerationError(tenantId, options.generation, existing.generation);
    }
    await executeRaw(
      scoped,
      sql`
        DELETE FROM ${appVariablesTable()}
        WHERE tenant_id = ${tenantId}
          AND namespace = ${TENANT_WRITE_GATE_NAMESPACE}
          AND key = ${TENANT_WRITE_GATE_KEY}
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
 */
export async function assertTenantWriteGateGeneration(
  scopedDb: Database,
  tenantId: string,
  generation: string
): Promise<void> {
  const existing = await readGateRowScoped(scopedDb, tenantId);
  if (!existing || existing.generation !== generation) {
    throw new TenantWriteGateGenerationError(tenantId, generation, existing?.generation);
  }
}
