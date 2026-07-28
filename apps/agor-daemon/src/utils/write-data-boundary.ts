import { BadRequest } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';

const PREPARED_WRITE_DATA = Symbol('agor.prepared-write-data');

type PreparedParams = Record<PropertyKey, unknown>;

function unsupportedFields(data: unknown, allowedFields: readonly string[]): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequest('Write data must be an object');
  }
  const allowed = new Set(allowedFields);
  return Object.keys(data).filter((key) => !allowed.has(key));
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
 */
export function markWriteDataPrepared() {
  return (context: HookContext): HookContext => {
    (context.params as PreparedParams)[PREPARED_WRITE_DATA] = true;
    return context;
  };
}

export function isWriteDataPrepared(params: unknown): boolean {
  return Boolean((params as PreparedParams | undefined)?.[PREPARED_WRITE_DATA]);
}

/** Defense-in-depth for direct service consumers that bypass Feathers hooks. */
export function assertServiceWriteFields(
  resource: string,
  data: unknown,
  allowedFields: readonly string[],
  params?: unknown,
  preparedFields: readonly string[] = []
): void {
  const effectiveFields = isWriteDataPrepared(params)
    ? [...allowedFields, ...preparedFields]
    : allowedFields;
  const unsupported = unsupportedFields(data, effectiveFields);
  if (unsupported.length > 0) {
    throw new BadRequest(
      `${resource} contains unsupported write fields: ${unsupported.sort().join(', ')}`
    );
  }
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
