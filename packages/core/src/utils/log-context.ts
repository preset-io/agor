/**
 * Run context attached to every JSON log line (`AGOR_LOG_FORMAT=json`).
 *
 * Log-only identity: nothing here gates database tenancy or authorization.
 * The tenant comes from the ambient tenant scope; the other fields are set by
 * the request, dispatch, or single-run process that owns the work.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentTenantId } from '../db/tenant-context';

export const LOG_CONTEXT_FIELDS = [
  'tenant_id',
  'user_id',
  'session_id',
  'task_id',
  'branch_id',
] as const;

export type LogContextField = (typeof LOG_CONTEXT_FIELDS)[number];
export type LogContext = Partial<Record<LogContextField, string>>;

const LOG_CONTEXT_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const FIELD_SET: ReadonlySet<string> = new Set(LOG_CONTEXT_FIELDS);

/**
 * One store per process, not per bundled copy of this module: `@agor/core`
 * ships with `splitting: false`, so the logger entry and this entry each
 * inline their own copy. See `processScopeStore` in `db/tenant-context.ts`.
 */
function processLogContextStore(): AsyncLocalStorage<LogContext> {
  const registry = globalThis as typeof globalThis & Record<symbol, unknown>;
  const symbol = Symbol.for('agor.utils.log-context');
  const existing = registry[symbol];
  if (existing) return existing as AsyncLocalStorage<LogContext>;
  const created = new AsyncLocalStorage<LogContext>();
  registry[symbol] = created;
  return created;
}

function processBaseHolder(): { base: LogContext } {
  const registry = globalThis as typeof globalThis & Record<symbol, unknown>;
  const symbol = Symbol.for('agor.utils.log-context.process-base');
  const existing = registry[symbol];
  if (existing) return existing as { base: LogContext };
  const created = { base: {} };
  registry[symbol] = created;
  return created;
}

const logContextStore = processLogContextStore();
const processBase = processBaseHolder();

function validValue(value: unknown): string | undefined {
  return typeof value === 'string' && LOG_CONTEXT_VALUE.test(value) ? value : undefined;
}

/** Keep only known fields with bounded identifier values; drop everything else silently. */
function sanitize(fields: Partial<Record<string, unknown>>): LogContext {
  const context: LogContext = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_SET.has(key)) continue;
    const safe = validValue(value);
    if (safe) context[key as LogContextField] = safe;
  }
  return context;
}

/**
 * Run `fn` with a fresh, mutable copy of the enclosing context plus `fields`.
 * Nested scopes inherit the parent's IDs; a child's `setLogContextField` never
 * writes into the parent.
 */
export function runWithLogContext<T>(
  fields: Partial<Record<LogContextField, string | undefined>>,
  fn: () => T
): T {
  return logContextStore.run({ ...logContextStore.getStore(), ...sanitize(fields) }, fn);
}

/** Process-wide base context for single-run processes (e.g. one executor run). */
export function setProcessLogContext(
  fields: Partial<Record<LogContextField, string | undefined>>
): void {
  processBase.base = sanitize(fields);
}

/** Set one field on the current scope. No-op outside `runWithLogContext`. */
export function setLogContextField(key: LogContextField, value: unknown): void {
  const store = logContextStore.getStore();
  if (!store || !FIELD_SET.has(key)) return;
  const safe = validValue(value);
  if (safe) store[key] = safe;
}

/** Merged context: process base, then the current scope, then the active tenant scope. */
export function getLogContext(): LogContext {
  const context: LogContext = { ...processBase.base, ...logContextStore.getStore() };
  const tenantId = validValue(getCurrentTenantId());
  if (tenantId) context.tenant_id = tenantId;
  return context;
}
