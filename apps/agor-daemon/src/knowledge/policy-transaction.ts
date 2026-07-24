import {
  getCurrentTenantDatabase,
  isPostgresDatabase,
  isSQLiteDatabase,
  runDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';

/**
 * Run a short Knowledge policy/materialization unit of work in the active
 * tenant transaction, or create the equivalent direct-call transaction.
 * SQLite uses IMMEDIATE with bounded busy retries so its database-wide write
 * lock provides the same serialization boundary as the PostgreSQL policy row.
 */
export async function runKnowledgePolicyTransaction<T>(
  db: TenantScopeAwareDatabase,
  work: (tx: TenantScopedDatabase) => Promise<T>
): Promise<T> {
  const ambientDb = getCurrentTenantDatabase();
  if (ambientDb && isPostgresDatabase(ambientDb)) {
    return work(ambientDb as TenantScopedDatabase);
  }

  if (isSQLiteDatabase(db)) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runDatabaseTransaction(db, (tx) => work(tx as TenantScopedDatabase), {
          sqliteImmediate: true,
        });
      } catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY' || attempt >= 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  }

  return runDatabaseTransaction(db, (tx) => work(tx as TenantScopedDatabase));
}
