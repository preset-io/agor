/**
 * Internal-only: the id an `.agorpack` import pre-allocated for the row a
 * service create makes (board, branch, schedule), so a retried import adopts
 * the row instead of creating another one. Symbol keys cannot arrive through
 * REST/socket JSON, so callers outside the daemon can never choose an id.
 */
const IMPORTED_ROW_ID = Symbol('agor.imported-row-id');

export function withImportedRowId<T extends object>(params: T, id: string): T {
  return { ...params, [IMPORTED_ROW_ID]: id };
}

export function importedRowId(params: unknown): string | undefined {
  const id = (params as Record<PropertyKey, unknown> | undefined)?.[IMPORTED_ROW_ID];
  return typeof id === 'string' ? id : undefined;
}
