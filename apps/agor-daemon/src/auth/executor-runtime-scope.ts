import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, Params } from '@agor/core/types';

type ExecutorTokenPayload = {
  type?: string;
  purpose?: string;
  session_id?: string;
  sessionId?: string;
  task_id?: string;
  branch_id?: string;
};

function scopedPayload(context: HookContext): ExecutorTokenPayload | null {
  const payload = (context.params as AuthenticatedParams).authentication?.payload as
    | ExecutorTokenPayload
    | undefined;
  if (payload?.type !== 'executor-session') return null;
  if (payload.purpose !== 'executor-task') {
    throw new Forbidden('Executor token is not valid for this request');
  }
  return payload;
}

function expectClaim(claim: string | undefined, label: string): string {
  if (!claim) {
    throw new Forbidden(`Executor token is missing ${label} scope`);
  }
  return claim;
}

function expectMatch(claim: string, value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (String(value) !== claim) {
    throw new Forbidden(`Executor token ${label} scope does not match this request`);
  }
}

function setIfAbsent(target: Record<string, unknown>, key: string, value: string): void {
  if (target[key] === undefined || target[key] === null) target[key] = value;
}

/**
 * Restrict executor-session JWTs to the resource claims minted for the
 * executor turn. Normal user/API-key/service auth is intentionally ignored.
 *
 * For list endpoints, this fail-closes by injecting the token scope into the
 * service query. For object mutations, the request must either address the
 * scoped object directly or carry matching parent identifiers.
 */
export function executorRuntimeScopeGuard() {
  return async (context: HookContext): Promise<HookContext> => {
    const payload = scopedPayload(context);
    if (!payload) return context;

    const scope = {
      sessionId: payload.session_id ?? payload.sessionId,
      taskId: payload.task_id,
      branchId: payload.branch_id,
    };
    const data = (context.data ?? {}) as Record<string, unknown>;
    const query = ((context.params as Params).query ?? {}) as Record<string, unknown>;
    (context.params as Params).query = query;
    const id = typeof context.id === 'string' ? context.id : undefined;

    if (context.path === 'sessions') {
      const sessionId = expectClaim(scope.sessionId, 'session');
      if (context.method === 'find') {
        expectMatch(sessionId, query.session_id, 'session');
        setIfAbsent(query, 'session_id', sessionId);
        if (scope.branchId) {
          expectMatch(scope.branchId, query.branch_id, 'branch');
          setIfAbsent(query, 'branch_id', scope.branchId);
        }
      } else {
        expectMatch(sessionId, id ?? data.session_id ?? query.session_id, 'session');
        if (!id && data.session_id === undefined && query.session_id === undefined) {
          throw new Forbidden('Executor token session scope is required for this request');
        }
        if (scope.branchId)
          expectMatch(scope.branchId, data.branch_id ?? query.branch_id, 'branch');
      }
    } else if (context.path === 'tasks') {
      const taskId = expectClaim(scope.taskId, 'task');
      if (context.method === 'find') {
        expectMatch(taskId, query.task_id, 'task');
        setIfAbsent(query, 'task_id', taskId);
        if (scope.sessionId) {
          expectMatch(scope.sessionId, query.session_id, 'session');
          setIfAbsent(query, 'session_id', scope.sessionId);
        }
      } else {
        expectMatch(taskId, id ?? data.task_id ?? query.task_id, 'task');
        if (!id && data.task_id === undefined && query.task_id === undefined) {
          throw new Forbidden('Executor token task scope is required for this request');
        }
        if (scope.sessionId)
          expectMatch(scope.sessionId, data.session_id ?? query.session_id, 'session');
      }
    } else if (context.path === 'messages') {
      const taskId = expectClaim(scope.taskId, 'task');
      if (context.method === 'find') {
        expectMatch(taskId, query.task_id, 'task');
        setIfAbsent(query, 'task_id', taskId);
        if (scope.sessionId) {
          expectMatch(scope.sessionId, query.session_id, 'session');
          setIfAbsent(query, 'session_id', scope.sessionId);
        }
      } else if (context.method === 'create') {
        expectMatch(taskId, data.task_id ?? query.task_id, 'task');
        setIfAbsent(data, 'task_id', taskId);
        if (scope.sessionId)
          expectMatch(scope.sessionId, data.session_id ?? query.session_id, 'session');
      } else {
        throw new Forbidden('Executor token is not valid for this messages request');
      }
    } else if (context.path === 'branches') {
      const branchId = expectClaim(scope.branchId, 'branch');
      if (context.method === 'find') {
        expectMatch(branchId, query.branch_id, 'branch');
        setIfAbsent(query, 'branch_id', branchId);
      } else {
        expectMatch(branchId, id ?? data.branch_id ?? query.branch_id, 'branch');
        if (!id && data.branch_id === undefined && query.branch_id === undefined) {
          throw new Forbidden('Executor token branch scope is required for this request');
        }
      }
    }

    return context;
  };
}
