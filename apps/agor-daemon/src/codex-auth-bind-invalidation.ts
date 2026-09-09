import {
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { TaskID, UserID } from '@agor/core/types';
import { requestExecutorTermination } from './termination-coordinator.js';
import { withFreshTenantWrite } from './utils/tenant-db-scope.js';

export type CodexCredentialMutationReason = 'credentials_imported' | 'credentials_removed';

export type CodexCredentialBindInvalidator = (input: {
  tenantId: string;
  userId: UserID;
  reason: CodexCredentialMutationReason;
}) => Promise<void>;

interface InvalidationDeps {
  loadTargets: () => Promise<TaskID[]>;
  terminate: (taskId: TaskID, message: string) => Promise<void>;
}

/**
 * Retire every live branch-scoped Codex executor that pinned a credential inode
 * for this prompt actor before import/logout atomically replaced that pathname.
 *
 * Selection is actor-scoped by immutable `Task.created_by`, not Session owner:
 * collaborators mount their own auth file into the shared branch SDK home. A
 * termination request is persisted for every executing state. On another HA
 * replica the owning executor observes that durable STOPPING request and
 * cooperatively quiesces; the normal termination coordinator retains local
 * process-group containment when this daemon owns the executor.
 *
 * This runs after the credential mutation commits. A task that pinned the old
 * inode is therefore already present in an executing state and is selected;
 * a later task opens the new pathname. Failures are logged without exposing
 * credential material or rolling back an already-committed auth mutation.
 */
export async function invalidateLiveBranchCodexCredentialBinds(input: {
  app: Application;
  db: TenantScopeAwareDatabase;
  tenantId: string;
  userId: UserID;
  reason: CodexCredentialMutationReason;
  /** Deterministic unit-test seam; production callers must omit. */
  depsForTest?: InvalidationDeps;
}): Promise<void> {
  const { app, db, tenantId, userId, reason } = input;
  const loadTargets = async (): Promise<TaskID[]> =>
    runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
      const tasks = await new TaskRepository(tenantDb).findExecutingByCreator(userId);
      const sessions = new SessionRepository(tenantDb);
      const targets: TaskID[] = [];
      for (const task of tasks) {
        const session = await sessions.findById(task.session_id);
        if (session?.agentic_tool === 'codex' && session.sdk_home_scope === 'branch') {
          targets.push(task.task_id);
        }
      }
      return targets;
    });
  const terminate = async (taskId: TaskID, message: string): Promise<void> => {
    await requestExecutorTermination({
      app,
      taskId,
      cause: 'user_stop',
      errorMessage: message,
      runInFreshTenantWriteDatabase: (work) => withFreshTenantWrite(db, tenantId, work),
    });
  };

  let targets: TaskID[];
  try {
    targets = await (input.depsForTest?.loadTargets ?? loadTargets)();
  } catch (error) {
    console.warn(
      `[CodexAuth] Could not discover live credential binds after ${reason}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const message =
    reason === 'credentials_removed'
      ? 'Codex credentials were removed; stopping this task because its sandbox pinned the prior auth.json inode.'
      : 'Codex credentials were replaced; stopping this task so the next prompt binds the new auth.json inode.';
  const outcomes = await Promise.all(
    targets.map(async (taskId) => {
      try {
        await (input.depsForTest?.terminate ?? terminate)(taskId, message);
        return true;
      } catch (error) {
        console.warn(
          `[CodexAuth] Failed to request termination for Task ${taskId} after ${reason}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      }
    })
  );
  const requested = outcomes.filter(Boolean).length;
  if (requested > 0) {
    console.log(
      `[CodexAuth] Requested termination for ${requested} branch-scoped Codex task(s) after ${reason}.`
    );
  }
}
