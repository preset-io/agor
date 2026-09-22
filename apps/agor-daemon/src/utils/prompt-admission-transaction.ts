import {
  assertTenantWritable,
  getCurrentTenantDatabaseScope,
  isPostgresDatabaseHandle,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { SessionID } from '@agor/core/types';

import { promptAdmissionSqlState, safePromptDatabaseFailure } from './prompt-database-error.js';

export { promptAdmissionSqlState } from './prompt-database-error.js';

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
    const started = performance.now();
    let bodyStarted: number | undefined;
    let statementFailure: unknown;
    let failedDuringWork = false;
    try {
      return await runWithTenantDatabaseTransaction(db, tenantId, async (scoped) => {
        bodyStarted = performance.now();
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
      if (!retry) {
        throw safePromptDatabaseFailure(error, performance.now() - started, {
          attempt: attempt + 1,
          phase: rolledBackStatement ? 'statement' : 'commit_or_after_commit',
          acquisitionSetupMs:
            bodyStarted === undefined ? undefined : Math.round(bodyStarted - started),
        });
      }
      console.warn(
        `[prompt.admission] tenant_id=${JSON.stringify(tenantId)} session_id=${JSON.stringify(sessionId ?? null)} sqlstate=${sqlstate} elapsed_ms=${Math.round(performance.now() - started)} acquisition_setup_ms=${bodyStarted === undefined ? 'unknown' : Math.round(bodyStarted - started)} attempt=${attempt + 1} retry=true phase=statement`
      );
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
