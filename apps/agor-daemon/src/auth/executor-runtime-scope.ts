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

type Scope = {
  sessionId?: string;
  taskId?: string;
  branchId?: string;
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

function normalizePath(path: string | undefined): string {
  return (path ?? '').replace(/^\/+/, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function routeId(context: HookContext): string | undefined {
  return (context.params as Params & { route?: { id?: string } }).route?.id;
}

function routeSessionId(context: HookContext): string | undefined {
  return routeId(context) ?? (typeof context.id === 'string' ? context.id : undefined);
}

function recordsFromData(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.map((item) => {
      const record = asRecord(item);
      if (!record) {
        throw new Forbidden('Executor token requires scoped object payloads');
      }
      return record;
    });
  }
  const record = asRecord(data);
  if (!record) {
    throw new Forbidden('Executor token requires a scoped object payload');
  }
  return [record];
}

function expectExistingMatch(claim: string, value: unknown, label: string): void {
  if (String(value) !== claim) {
    throw new Forbidden(`Executor token ${label} scope does not match this request`);
  }
}

function scopeTaskRecord(record: Record<string, unknown>, scope: Scope): void {
  const taskId = expectClaim(scope.taskId, 'task');
  expectMatch(taskId, record.task_id, 'task');
  setIfAbsent(record, 'task_id', taskId);
  if (scope.sessionId) {
    expectMatch(scope.sessionId, record.session_id, 'session');
    setIfAbsent(record, 'session_id', scope.sessionId);
  }
}

function scopeStreamingEnvelope(data: unknown, scope: Scope): void {
  const envelope = asRecord(data);
  if (!envelope) {
    throw new Forbidden('Executor token requires a scoped streaming payload');
  }
  const eventData = asRecord(envelope.data);
  if (!eventData) {
    throw new Forbidden('Executor token requires scoped streaming event data');
  }
  scopeTaskRecord(eventData, scope);
}

async function loadMessageRecord(
  context: HookContext,
  id: string
): Promise<Record<string, unknown>> {
  const service = context.service as unknown as {
    findByIdForScopeCheck?: (id: string) => Promise<unknown>;
  };
  const record = asRecord(await service.findByIdForScopeCheck?.(id));
  if (!record) {
    throw new Forbidden('Executor token message scope is required for this request');
  }
  return record;
}

function requireMatchingSessionRoute(context: HookContext, scope: Scope): void {
  const sessionId = expectClaim(scope.sessionId, 'session');
  const query = ((context.params as Params).query ?? {}) as Record<string, unknown>;
  const requestedSessionId = routeSessionId(context) ?? query.session_id;
  expectMatch(sessionId, requestedSessionId, 'session');
  if (requestedSessionId === undefined || requestedSessionId === null) {
    throw new Forbidden('Executor token session scope is required for this request');
  }
}

async function requireMessageReadScope(
  context: HookContext,
  id: string,
  scope: Scope
): Promise<void> {
  const existing = await loadMessageRecord(context, id);

  if (scope.sessionId) {
    expectExistingMatch(scope.sessionId, existing.session_id, 'session');
    return;
  }

  const taskId = expectClaim(scope.taskId, 'task');
  expectExistingMatch(taskId, existing.task_id, 'task');
}

type AuthHook = (context: HookContext) => Promise<HookContext>;

export function scopeExecutorRuntimeAuth(requireAuth: AuthHook): AuthHook {
  return async (context: HookContext): Promise<HookContext> => {
    const authenticated = await requireAuth(context);
    return executorRuntimeScopeGuard()(authenticated);
  };
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
    const path = normalizePath(context.path);

    if (path === 'sessions') {
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
    } else if (path === 'tasks') {
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
    } else if (path === 'messages') {
      const taskId = expectClaim(scope.taskId, 'task');
      if (context.method === 'find') {
        const hasTaskQuery = query.task_id !== undefined && query.task_id !== null;
        const hasSessionQuery = query.session_id !== undefined && query.session_id !== null;
        if (hasTaskQuery) {
          expectMatch(taskId, query.task_id, 'task');
          if (scope.sessionId) {
            expectMatch(scope.sessionId, query.session_id, 'session');
            setIfAbsent(query, 'session_id', scope.sessionId);
          }
        } else if (hasSessionQuery) {
          const sessionId = expectClaim(scope.sessionId, 'session');
          expectMatch(sessionId, query.session_id, 'session');
        } else {
          setIfAbsent(query, 'task_id', taskId);
          if (scope.sessionId) {
            setIfAbsent(query, 'session_id', scope.sessionId);
          }
        }
      } else if (context.method === 'create') {
        for (const record of recordsFromData(context.data)) {
          expectMatch(taskId, record.task_id ?? query.task_id, 'task');
          setIfAbsent(record, 'task_id', taskId);
          if (scope.sessionId)
            expectMatch(scope.sessionId, record.session_id ?? query.session_id, 'session');
        }
      } else if (context.method === 'get') {
        if (!id) {
          throw new Forbidden('Executor token message scope is required for this request');
        }
        await requireMessageReadScope(context, id, scope);
      } else if (context.method === 'patch') {
        if (!id) {
          throw new Forbidden('Executor token message scope is required for this request');
        }
        const existing = await loadMessageRecord(context, id);
        expectExistingMatch(taskId, existing.task_id, 'task');
        expectMatch(taskId, data.task_id ?? query.task_id, 'task');
        if (scope.sessionId) {
          expectExistingMatch(scope.sessionId, existing.session_id, 'session');
          expectMatch(scope.sessionId, data.session_id ?? query.session_id, 'session');
        }
      } else {
        throw new Forbidden('Executor token is not valid for this messages request');
      }
    } else if (path === 'branches') {
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
    } else if (path === 'messages/bulk') {
      if (context.method !== 'create') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
      for (const record of recordsFromData(context.data)) {
        scopeTaskRecord(record, scope);
      }
    } else if (path === 'messages/streaming' || path === 'tasks/streaming') {
      if (context.method !== 'create') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
      scopeStreamingEnvelope(context.data, scope);
    } else if (path === 'sessions/:id/genealogy' || path === 'sessions/genealogy') {
      requireMatchingSessionRoute(context, scope);
    } else if (path === 'sessions/:id/mcp-servers' || path === 'sessions/mcp-servers') {
      if (context.method !== 'find') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
      requireMatchingSessionRoute(context, scope);
    } else {
      throw new Forbidden('Executor token is not valid for this endpoint');
    }

    return context;
  };
}
