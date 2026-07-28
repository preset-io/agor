import { BadRequest } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';

const PREPARED_WRITE_DATA = Symbol('agor.prepared-write-data');

type PreparedParams = Record<PropertyKey, unknown>;

/**
 * Fields that trusted runtime infrastructure — never the client — owns.
 *
 * `tenant_id` is stamped onto tenant-owned create payloads by the tenant
 * scoping hook (`scopeTenantBefore`) and, authoritatively, applied at the
 * database layer from ambient tenant context (`withTenantInsertValues`), which
 * also drops it for dialects that lack the column (SQLite). It is therefore not
 * a client-supplied field and must not be reported as unsupported: doing so
 * makes every create on a tenant-owned service that enforces a public-write
 * allowlist (schedules, gateway channels) fail in multi-tenant mode.
 *
 * Ignoring it here cannot weaken tenant isolation — `pickWriteFields` still
 * omits it (the DB layer stays the single source of truth), so any
 * client-supplied value is stripped before the insert and overwritten by the
 * trusted ambient tenant.
 */
const SERVER_MANAGED_WRITE_FIELDS: ReadonlySet<string> = new Set(['tenant_id']);

function unsupportedFields(data: unknown, allowedFields: readonly string[]): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequest('Write data must be an object');
  }
  const allowed = new Set(allowedFields);
  return Object.keys(data).filter(
    (key) => !allowed.has(key) && !SERVER_MANAGED_WRITE_FIELDS.has(key)
  );
}

/**
 * Reject fields outside a public DTO before subsequent hooks add trusted,
 * runtime-owned fields. This is a runtime boundary; TypeScript DTOs alone do
 * not sanitize REST or socket payloads.
 */
export function enforcePublicWriteFields(resource: string, allowedFields: readonly string[]) {
  return (context: HookContext): HookContext => {
    const unsupported = unsupportedFields(context.data, allowedFields);
    if (unsupported.length > 0) {
      throw new BadRequest(
        `${resource} contains unsupported write fields: ${unsupported.sort().join(', ')}`
      );
    }
    return context;
  };
}

/**
 * Mark data after trusted hooks finish adding runtime-owned values. Symbols
 * cannot be supplied through REST/socket JSON and are scoped to this process.
 * The exact payload object is recorded so reusable params cannot confer trust
 * on a later payload.
 */
export function markWriteDataPrepared() {
  return (context: HookContext): HookContext => {
    (context.params as PreparedParams)[PREPARED_WRITE_DATA] = context.data;
    return context;
  };
}

function consumeWriteDataPrepared(params: unknown, data: unknown): boolean {
  const preparedParams = params as PreparedParams | undefined;
  if (!preparedParams || preparedParams[PREPARED_WRITE_DATA] !== data) return false;
  delete preparedParams[PREPARED_WRITE_DATA];
  return true;
}

/**
 * Defense-in-depth for direct service consumers that bypass Feathers hooks.
 * Prepared trust is bound to this payload and consumed exactly once.
 */
export function assertServiceWriteFields(
  resource: string,
  data: unknown,
  allowedFields: readonly string[],
  params?: unknown,
  preparedFields: readonly string[] = []
): boolean {
  const prepared = consumeWriteDataPrepared(params, data);
  const effectiveFields = prepared ? [...allowedFields, ...preparedFields] : allowedFields;
  const unsupported = unsupportedFields(data, effectiveFields);
  if (unsupported.length > 0) {
    throw new BadRequest(
      `${resource} contains unsupported write fields: ${unsupported.sort().join(', ')}`
    );
  }
  return prepared;
}

/** Pick a DTO-shaped payload so runtime-owned values never reach a repository by accident. */
export function pickWriteFields<T extends object>(
  data: Record<string, unknown>,
  allowedFields: readonly string[]
): T {
  const picked: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (Object.hasOwn(data, field)) picked[field] = data[field];
  }
  return picked as T;
}
