import {
  assertTenantWritable,
  getCurrentTenantDatabaseScope,
  isPostgresDatabaseHandle,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { Unavailable } from '@agor/core/feathers';
import type { SessionID } from '@agor/core/types';

/** Drizzle and repositories wrap the driver's SQLSTATE in nested causes. */
export function promptAdmissionSqlState(error: unknown): string | undefined {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    if (seen.has(error)) return undefined;
    seen.add(error);
    const { code, cause } = error as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    error = cause;
  }
  return undefined;
}

/**
 * Only the prompt's DB-only enqueue unit may be replayed, never the route,
 * dispatch claim, transcript repair, title generation, or executor launch.
 * Retry statement failures only after the owning transaction has rolled back.
 * A joined transaction belongs to its caller; a savepoint is not a restart.
 * Commit/connection/post-commit failures are deliberately NOT replayed, even
 * with a transient-looking code: durable admission may already have happened.
 */
export async function runPromptAdmissionTransaction<T>(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  work: (db: TenantScopedDatabase) => Promise<T>,
  sessionId?: SessionID
): Promise<T> {
  const scope = getCurrentTenantDatabaseScope();
  const ownsTransaction = !scope || (scope.kind === 'tenant' && !scope.transactionActive);
  const postgres = isPostgresDatabaseHandle(db);
  for (let attempt = 0; ; attempt++) {
    let statementFailure: unknown;
    let failedDuringWork = false;
    try {
      return await runWithTenantDatabaseTransaction(db, tenantId, async (scoped) => {
        try {
          await assertTenantWritable(scoped, tenantId);
          return await work(scoped);
        } catch (error) {
          failedDuringWork = true;
          statementFailure = error;
          throw error;
        }
      });
    } catch (error) {
      const sqlstate = postgres ? promptAdmissionSqlState(error) : undefined;
      // Never disguise an error from a caller-owned transaction as a fresh
      // admission result; propagate it so that owner can roll back.
      if (!ownsTransaction || !sqlstate) throw error;
      const rolledBackStatement = failedDuringWork && statementFailure === error;
      const retry =
        rolledBackStatement && attempt < 2 && (sqlstate === '40P01' || sqlstate === '40001');
      console.warn(
        `[prompt.admission] tenant_id=${JSON.stringify(tenantId)} session_id=${JSON.stringify(sessionId ?? null)} sqlstate=${sqlstate} attempt=${attempt + 1} retry=${retry} phase=${rolledBackStatement ? 'statement' : 'commit_or_after_commit'}`
      );
      if (!retry) {
        const failure = new Unavailable(
          'Could not confirm prompt admission. Check the session before sending again.'
        );
        // Preserve internal diagnostics without exposing SQL/params in the
        // Feathers wire error or enumerable structured logging fields.
        Object.defineProperty(failure, 'cause', { value: error });
        throw failure;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
