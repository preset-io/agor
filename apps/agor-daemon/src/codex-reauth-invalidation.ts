import {
  BranchRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { UserID } from '@agor/core/types';
import { getTrackedExecutor } from './executor-tracking.js';
import { requestExecutorTermination } from './termination-coordinator.js';
import { withFreshTenantWrite } from './utils/tenant-db-scope.js';

/**
 * Invalidate live Codex sessions holding a per-branch auth.json bind for a user
 * after that user re-authenticates (design §8A.8 test B, option 1 — the
 * recommended resolution).
 *
 * Why: a Codex subscription session on an SDK-home branch runs with the caller's
 * real `auth.json` bind-mounted onto the branch home. The daemon's re-auth write
 * is `atomicWrite` (temp file + rename), which REPLACES the inode. The Phase-1
 * spike confirmed a live bind keeps serving the prior (now-unlinked) inode and
 * silently orphans its refresh writes — so a live Codex session must be
 * restarted to pick up the new credential. Restarting = terminate the live
 * executor; the next prompt re-binds the fresh `auth.json` in a new mount
 * namespace.
 *
 * Scope of this minimal-but-correct implementation:
 *  - Targets running Codex tasks whose SESSION OWNER is the re-authenticating
 *    user (the bind uses the owner's home in Phase 3) on branches that have a
 *    per-branch SDK home.
 *  - Only terminates executors this daemon tracks locally (a supported, safe
 *    operation — the same primitive the Stop button uses). Cross-replica live
 *    Codex sessions in an HA deployment are NOT reached by this event; they
 *    converge on their own next restart. This residual is documented rather
 *    than silently skipped.
 *  - Best-effort: failures are logged, never thrown, so re-auth still succeeds.
 */
export async function invalidateLiveCodexBindsForUser(input: {
  app: Application;
  db: TenantScopeAwareDatabase;
  tenantId: string | undefined;
  userId: UserID;
}): Promise<void> {
  const { app, db, tenantId, userId } = input;
  try {
    const targets = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
      const running = await new TaskRepository(tenantDb).findRunning();
      if (running.length === 0) return [];
      const sessionRepo = new SessionRepository(tenantDb);
      const branchRepo = new BranchRepository(tenantDb);
      const out: string[] = [];
      for (const task of running) {
        // Only executors live on THIS daemon can be restarted from here.
        if (!getTrackedExecutor(task.session_id)) continue;
        const session = await sessionRepo.findById(task.session_id);
        if (session?.agentic_tool !== 'codex') continue;
        // Phase 3 keeps owner-scoped homes, so the bind uses the owner's
        // credential — invalidate the sessions whose owner just re-authed.
        if (session.created_by !== userId || !session.branch_id) continue;
        const branch = await branchRepo.findById(session.branch_id);
        if (branch?.sdk_home !== 'per_branch') continue;
        out.push(task.task_id);
      }
      return out;
    });

    for (const taskId of targets) {
      try {
        await requestExecutorTermination({
          app,
          taskId,
          cause: 'user_stop',
          errorMessage:
            'Codex credentials were re-authenticated; restarting so the session picks up the ' +
            'new auth.json (a live bind keeps serving the replaced credential inode).',
          runInFreshTenantWriteDatabase: (work) => withFreshTenantWrite(db, tenantId, work),
        });
      } catch (err) {
        console.warn(
          `[CodexAuth] Failed to invalidate live Codex task ${taskId} after re-auth: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (targets.length > 0) {
      console.log(
        `[CodexAuth] Re-auth invalidated ${targets.length} live Codex session(s) for user ` +
          `${userId} so they re-bind the fresh auth.json.`
      );
    }
  } catch (err) {
    console.warn(
      `[CodexAuth] Codex re-auth live-session invalidation failed (non-fatal): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}
