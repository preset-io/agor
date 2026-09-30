/** No raw error text, SQL, paths, or arbitrary provider codes enter diagnostics. */
export function deletionErrorCategory(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const { code, name, cause } = current as { code?: unknown; name?: unknown; cause?: unknown };
    // These PostgreSQL server responses abort the transaction. This is NOT
    // inferred from an HTTP status or a transport timeout, nor does it imply
    // that earlier transactions rolled back or external work was contained.
    if (code === '40001') return 'database_serialization_abort';
    if (code === '40P01') return 'database_deadlock_abort';
    if (code === '55P03') return 'database_lock_unavailable';
    if (code === '57014') return 'database_query_cancelled';
    if (code === '23503') return 'database_foreign_key';
    if (code === '23505') return 'database_unique_constraint';
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'database_busy';
    if (name === 'MissingTenantDatabaseScopeError') return 'tenant_scope_missing';
    if (name === 'Forbidden') return 'authorization_denied';
    if (name === 'BadRequest') return 'request_rejected';
    if (name === 'RepositoryError' && !cause) return 'ownership_or_precondition';
    current = cause;
  }
  return 'outcome_unknown';
}
