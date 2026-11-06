import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getCurrentTenantId,
  isPostgresDatabaseHandle,
  readTenantRestrictionState,
  type TenantRestrictionState,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, Unavailable } from '@agor/core/feathers';
import { type HookContext, TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';
import {
  assertTenantCredentialEpochValue,
  type TenantRestrictionReader,
  tenantCredentialEpoch,
} from './tenant-credential-epoch.js';
import { isTenantSafetySettlement } from './tenant-safety-settlement.js';
import { hasTerminationReadAuthority } from './termination-read-authority.js';

/** Freshness bound shared by the socket monitor tick, request memo and publisher epoch cache. */
export const TENANT_RESTRICTION_OBSERVATION_MS = 1000;
/** Longest wait on one restriction observation before the monitor or publisher skips a tick. */
export const TENANT_RESTRICTION_READ_TIMEOUT_MS = 2000;

const requestReads = new AsyncLocalStorage<{
  until: number;
  /** Deadline of the scope that admission ended, for credential issuance only. */
  admittedUntil?: number;
  reads: Map<string, Promise<TenantRestrictionState>>;
  /** Streaming relay packet: its checks take the per-tenant shared observation current at each check. */
  shared?: { tenantId: string; observe: (tenantId: string) => SharedTenantRestrictionObservation };
}>();

/** Share one restriction read across a handshake/packet/request's admission checks; reuse never exceeds one tick. */
export function withTenantRestrictionRequest<T>(work: () => T, reuse = false): T {
  const current = requestReads.getStore();
  if (reuse && current && (current.shared || performance.now() < current.until)) return work();
  const until = performance.now() + TENANT_RESTRICTION_OBSERVATION_MS;
  return requestReads.run({ until, reads: new Map() }, work);
}

/** Admission is decided: later checks in this async context (service bodies, background work) read fresh. */
export function endTenantRestrictionRequest(): void {
  const current = requestReads.getStore();
  if (!current) return;
  current.shared = undefined;
  if (current.until) current.admittedUntil = current.until;
  current.until = 0;
}

/** Memoized within an open request scope only; uncached across requests. */
export const readRequestTenantRestriction: TenantRestrictionReader = (db, tenantId) => {
  const current = requestReads.getStore();
  if (current?.shared?.tenantId === tenantId) return current.shared.observe(tenantId).state;
  if (!current || performance.now() >= current.until)
    return readTenantRestrictionState(db, tenantId);
  let read = current.reads.get(tenantId);
  if (!read) {
    read = readTenantRestrictionState(db, tenantId);
    current.reads.set(tenantId, read);
  }
  return read;
};

/** One restriction observation and the monotonic time its read started. */
export interface SharedTenantRestrictionObservation {
  startedAt: number;
  state: Promise<TenantRestrictionState>;
}

/** Per-tenant single-flight read reused for at most one tick from its start; never shared across tenants. */
export function createSharedTenantRestrictionObservation(
  read: (tenantId: string) => Promise<TenantRestrictionState>
): (tenantId: string) => SharedTenantRestrictionObservation {
  const observations = new Map<string, SharedTenantRestrictionObservation>();
  let nextEviction = 0;
  return (tenantId) => {
    const at = performance.now();
    if (at >= nextEviction) {
      for (const [id, entry] of observations)
        if (at - entry.startedAt >= TENANT_RESTRICTION_OBSERVATION_MS) observations.delete(id);
      nextEviction = at + TENANT_RESTRICTION_OBSERVATION_MS;
    }
    const current = observations.get(tenantId);
    if (current && at - current.startedAt < TENANT_RESTRICTION_OBSERVATION_MS) return current;
    const state = Promise.resolve().then(() => read(tenantId));
    // Every sharer awaits it; this only keeps a failure nobody else awaits from going unhandled.
    state.catch(() => undefined);
    const observation = { startedAt: at, state };
    observations.set(tenantId, observation);
    return observation;
  };
}

/** One shared read; `until` stays infinite while it is pending, then marks the end of its reuse. */
export interface TenantReadEntry<T> {
  startedAt: number;
  until: number;
  value: Promise<T>;
}

/** Per-tenant single-flight read reused `reuseMs` from its start once settled; a read pending past `abandonAfterMs` is abandoned once, never stacked. */
export function createTenantReadCache<T>(
  read: (tenantId: string) => Promise<T>,
  options: {
    abandonAfterMs: number;
    reuseMs?: number;
    /** Running reads, abandoned ones included, past which a lookup starts none and returns undefined. */
    maxRunning?: number;
    now?: () => number;
  }
): (tenantId: string) => TenantReadEntry<T> | undefined {
  const reuseMs = options.reuseMs ?? 0;
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, TenantReadEntry<T>>();
  const abandoned = new Map<string, Promise<T>>();
  let running = 0;
  let nextEviction = 0;
  return (tenantId) => {
    // Monotonic, so a wall-clock step cannot abandon a read early or keep a wedged one forever.
    const at = now();
    if (at >= nextEviction) {
      // Settled entries past their reuse are dropped; in-flight reads are only replaced on lookup.
      for (const [id, stale] of entries) if (at >= stale.until) entries.delete(id);
      nextEviction = at + TENANT_RESTRICTION_OBSERVATION_MS;
    }
    let current = entries.get(tenantId);
    const wedged =
      current?.until === Number.POSITIVE_INFINITY &&
      at - current.startedAt >= options.abandonAfterMs;
    if (current && wedged && !abandoned.has(tenantId)) {
      const stale = current.value;
      entries.delete(tenantId);
      abandoned.set(tenantId, stale);
      const forget = () => {
        if (abandoned.get(tenantId) === stale) abandoned.delete(tenantId);
      };
      stale.then(forget, forget);
      current = undefined;
    }
    if (current && at < current.until) return current;
    if (options.maxRunning !== undefined && running >= options.maxRunning) return undefined;
    const created = { startedAt: at, until: Number.POSITIVE_INFINITY, value: read(tenantId) };
    running++;
    const settle = () => {
      running--;
      created.until = created.startedAt + reuseMs;
    };
    created.value.then(settle, settle);
    entries.set(tenantId, created);
    return created;
  };
}

/** Route this packet's checks, service hook included, through the shared observation: at most one read per tenant per tick, each under a tick old when used. */
export function shareTenantRestrictionRead(
  tenantId: string,
  observe: (tenantId: string) => SharedTenantRestrictionObservation
): void {
  const current = requestReads.getStore();
  if (!current || performance.now() >= current.until || current.reads.has(tenantId)) return;
  current.shared = { tenantId, observe };
}

/** Credential issuance after admission reuses the read that admitted this request within its tick; never an admission check. */
export const readAdmittedTenantRestriction: TenantRestrictionReader = (db, tenantId) => {
  const current = requestReads.getStore();
  const until = Math.max(current?.until ?? 0, current?.admittedUntil ?? 0);
  const read = current && performance.now() < until ? current.reads.get(tenantId) : undefined;
  return read ?? readTenantRestrictionState(db, tenantId);
};

export async function assertRuntimeTenantRequestAccess(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  context: HookContext
): Promise<void> {
  if (context.params.tenant?.tenant_id !== tenantId)
    throw new Forbidden('Tenant authority mismatch');
  if (hasTerminationReadAuthority(context) || (await isTenantSafetySettlement(context))) return;
  const { authentication } = context.params;
  await assertRuntimeTenantAccess(
    db,
    tenantId,
    authentication?.strategy === 'jwt' ? { payload: authentication.payload } : undefined,
    readRequestTenantRestriction
  );
}

/** For tenant-owned background admission; missing scope or DB failure never opens work. */
export async function isCurrentTenantRuntimeActive(db: TenantScopeAwareDatabase): Promise<boolean> {
  if (!isPostgresDatabaseHandle(db)) return true;
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Unavailable('Tenant access cannot be verified');
  try {
    await assertRuntimeTenantAccess(db, tenantId);
    return true;
  } catch (error) {
    if (error instanceof Forbidden) return false;
    throw error;
  }
}

/** Ordinary admission after tenant resolution: one read decides access and any signed credential's generation; no exemptions. */
export async function assertRuntimeTenantAccess(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  credential?: { payload: unknown },
  read: TenantRestrictionReader = readTenantRestrictionState
): Promise<void> {
  // Hosted restriction authority is PostgreSQL-only; SQLite keeps standalone behavior.
  if (!isPostgresDatabaseHandle(db)) return;
  let state: TenantRestrictionState;
  try {
    state = await read(db, tenantId);
  } catch {
    // Diagnostics stay private, and a failed read never reads as unrestricted.
    throw new Unavailable('Tenant access cannot be verified');
  }
  if (state.closed) {
    // The stable code is the whole disclosure: no controller, placement, revision or phase.
    throw new Forbidden('Tenant access is restricted', { code: TENANT_RESTRICTED_ERROR_CODE });
  }
  if (credential) {
    assertTenantCredentialEpochValue(tenantCredentialEpoch(state, tenantId), credential.payload);
  }
}

/** Check source occurrence time, not retry/receive time, to avoid replay after release. */
export async function isCurrentTenantEventAdmitted(
  db: TenantScopeAwareDatabase,
  occurredAt: number
): Promise<boolean> {
  if (!isPostgresDatabaseHandle(db)) return true;
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Unavailable('Tenant access cannot be verified');
  const state = await readTenantRestrictionState(db, tenantId);
  return (
    !state.closed &&
    (state.resumeAfter === undefined ||
      (Number.isFinite(occurredAt) && occurredAt > state.resumeAfter))
  );
}

export function gatewayOccurrenceTime(timestamp: string): number {
  // Slack uses decimal Unix seconds; other connectors use ISO timestamps.
  return /^\d{10}(?:\.\d+)?$/.test(timestamp) ? Number(timestamp) * 1000 : Date.parse(timestamp);
}

/** True only for the neutral restriction denial; an unverifiable read (503) or rejected credential (401) never is. */
export function isTenantRestrictedRejection(error: unknown): boolean {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return false;
  return (data as { code?: unknown }).code === TENANT_RESTRICTED_ERROR_CODE;
}
