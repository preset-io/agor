import {
  assertTenantWritable,
  getCurrentTenantDatabaseScope,
  getPostgresSqlState,
  isPostgresDatabaseHandle,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';

import { safePromptDatabaseFailure } from './prompt-database-error.js';

/** Observe one admission transaction. Never replay it, including transient SQLSTATEs. */
export async function runPromptAdmissionTransaction<T>(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  work: (db: TenantScopedDatabase) => Promise<T>
): Promise<T> {
  const scope = getCurrentTenantDatabaseScope();
  const ownsTransaction = !scope || (scope.kind === 'tenant' && !scope.transactionActive);
  const postgres = isPostgresDatabaseHandle(db);
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
    const sqlstate = postgres ? getPostgresSqlState(error) : undefined;
    // Never disguise an error from a caller-owned transaction as a fresh
    // admission result; propagate it so that owner can roll back.
    if (!ownsTransaction || !sqlstate) throw error;
    const rolledBackStatement = failedDuringWork && statementFailure === error;
    throw safePromptDatabaseFailure(error, performance.now() - started, {
      attempt: 1,
      phase:
        bodyStarted === undefined
          ? 'acquisition_or_setup'
          : rolledBackStatement
            ? 'statement'
            : 'commit_or_after_commit',
      acquisitionSetupMs: bodyStarted === undefined ? undefined : Math.round(bodyStarted - started),
    });
  }
}
