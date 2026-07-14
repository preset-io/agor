import {
  BranchRepository,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Params, Task } from '@agor/core/types';
import { getHomedirFromUsername } from '@agor/core/unix';
import type { Application, TasksServiceImpl } from '../declarations.js';
import { pushAsync } from './session-state-hooks.js';

interface PersistExecutorSessionStateOptions {
  app: Pick<Application, 'service'>;
  db: TenantScopeAwareDatabase;
  taskId: string;
  executorAttemptId: string;
  params?: Params;
}

interface PersistExecutorSessionStateDependencies {
  pushState?: typeof pushAsync;
  resolveBranchPath?: (branchId: string) => Promise<string | undefined>;
  resolveExecutorHome?: (unixUser: string | undefined) => string | undefined;
}

/** Persist the SDK session file while the executor attempt still owns the release fence. */
export async function persistExecutorSessionState(
  options: PersistExecutorSessionStateOptions,
  dependencies: PersistExecutorSessionStateDependencies = {}
): Promise<boolean> {
  const tasksService = options.app.service('tasks') as unknown as TasksServiceImpl;
  const ownsFence = () =>
    tasksService.ownsExecutorFinalizationFence(
      options.taskId,
      options.executorAttemptId,
      options.params
    );
  if (!(await ownsFence())) return false;

  const task = (await tasksService.get(options.taskId, options.params)) as Task;
  if (task.session_md5) return true;

  const session = await options.app.service('sessions').get(task.session_id, options.params);
  if (!session.sdk_session_id || !session.branch_id) return false;

  const branchPath = await (dependencies.resolveBranchPath
    ? dependencies.resolveBranchPath(session.branch_id)
    : resolveBranchPath(options.db, session.branch_id));
  if (!branchPath) return false;

  const unixUser = task.executor_finalization?.workload?.unix_user;
  const executorHomeDir = (dependencies.resolveExecutorHome ?? getHomedirFromUsername)(unixUser);
  const md5 = await (dependencies.pushState ?? pushAsync)({
    db: options.db,
    sessionId: task.session_id,
    branchId: session.branch_id,
    taskId: task.task_id,
    sdkSessionId: session.sdk_session_id,
    branchPath,
    tool: session.agentic_tool,
    executorHomeDir,
    isCurrentTask: ownsFence,
  });
  if (!md5 || !(await ownsFence())) return false;

  await tasksService.patch(task.task_id, { session_md5: md5 }, options.params);
  return true;
}

async function resolveBranchPath(
  db: TenantScopeAwareDatabase,
  branchId: string
): Promise<string | undefined> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) return undefined;
  const branch = await runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
    new BranchRepository(tenantDb).findById(branchId)
  );
  return branch?.path;
}
