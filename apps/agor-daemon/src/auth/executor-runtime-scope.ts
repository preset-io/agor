import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, Branch, BranchID, HookContext, Params } from '@agor/core/types';
import {
  BRANCH_ARCHIVE_LIFECYCLE_FIELDS,
  BRANCH_FILESYSTEM_LIFECYCLE_FIELDS,
  BRANCH_IMMUTABLE_FIELDS,
  BRANCH_SERVER_MANAGED_FIELDS,
} from '@agor/core/types';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
  type ExecutorSessionTokenPayload,
  getExecutorSessionTokenSessionId,
  isExecutorSessionTokenPayload,
} from './executor-session-token.js';

type Scope = {
  sessionId?: string;
  taskId?: string;
  branchId?: string;
};

function scopedPayload(context: HookContext): ExecutorSessionTokenPayload | null {
  const params = context.params as AuthenticatedParams & ExecutorSessionTokenPayload;
  const payload = params.authentication?.payload as ExecutorSessionTokenPayload | undefined;
  if (payload?.type === EXECUTOR_SESSION_TOKEN_TYPE) {
    if (!isExecutorSessionTokenPayload(payload)) {
      throw new Forbidden('Executor token is not valid for this request');
    }
    return payload;
  }

  // Socket.io can preserve custom auth-result fields (`task_id`, `session_id`)
  // on the connection while dropping the decoded JWT payload. Treat those
  // fields as executor scope only when they came from JWT auth and carry a task
  // claim; normal user/API-key auth must continue through unscoped.
  if (params.authentication?.strategy === 'jwt' && payload === undefined && params.task_id) {
    return {
      type: EXECUTOR_SESSION_TOKEN_TYPE,
      purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
      task_id: params.task_id,
      session_id: params.session_id,
      sessionId: params.sessionId,
      branch_id: params.branch_id,
    };
  }

  if (payload?.type !== undefined) return null;
  return null;
}

/** Whether this authenticated transport request carries executor scope for one task. */
export function isTaskScopedExecutorRequest(context: HookContext, taskId: string): boolean {
  return scopedPayload(context)?.task_id === taskId;
}

/** Whether this request carries a validated executor scope for one branch. */
export function isBranchScopedExecutorRequest(context: HookContext, branchId: string): boolean {
  return scopedPayload(context)?.branch_id === branchId;
}

type BranchExecutorServicePayload = {
  type: 'service';
  sub: 'executor-service';
  purpose: 'executor-service';
  role: 'service';
  command: string;
  branch_id: string;
  filesystem_operation_id?: string;
};

function isBranchExecutorServicePayload(value: unknown): value is BranchExecutorServicePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<BranchExecutorServicePayload>;
  return (
    payload.type === 'service' &&
    payload.sub === 'executor-service' &&
    payload.purpose === 'executor-service' &&
    payload.role === 'service' &&
    typeof payload.command === 'string' &&
    typeof payload.branch_id === 'string'
  );
}

export type BranchFilesystemLifecycleCapability =
  | { kind: 'create'; operationId: string }
  | { kind: 'delete'; operationId: string; metadataRemovalAllowed: boolean };

export function getBranchFilesystemLifecycleCapability(
  params: AuthenticatedParams,
  branchId: string
): BranchFilesystemLifecycleCapability | null {
  const context = { params } as HookContext;
  const executorPayload = scopedPayload(context);
  if (
    executorPayload?.branch_id === branchId &&
    executorPayload.task_id === undefined &&
    typeof executorPayload.filesystem_operation_id === 'string' &&
    (executorPayload.session_id === 'branch-delete' ||
      executorPayload.session_id === 'branch-remove')
  ) {
    return {
      kind: 'delete',
      operationId: executorPayload.filesystem_operation_id,
      metadataRemovalAllowed: executorPayload.session_id === 'branch-remove',
    };
  }
  const payload = params.authentication?.payload;
  if (
    isBranchExecutorServicePayload(payload) &&
    payload.command === 'git.branch.add' &&
    payload.branch_id === branchId &&
    typeof payload.filesystem_operation_id === 'string'
  ) {
    return { kind: 'create', operationId: payload.filesystem_operation_id };
  }
  return null;
}

/**
 * Whether a verified executor transport may report filesystem lifecycle state
 * for this branch. Deletion uses an executor-session token; materialization
 * uses the narrowly-command-scoped service token minted by ReposService and
 * BranchesService.unarchive.
 */
export function isBranchFilesystemLifecycleExecutorRequest(
  context: HookContext,
  branchId: string
): boolean {
  return (
    getBranchFilesystemLifecycleCapability(context.params as AuthenticatedParams, branchId) !== null
  );
}

/** Whether an executor service credential may stamp this branch's Unix group. */
export function isBranchUnixGroupExecutorRequest(context: HookContext, branchId: string): boolean {
  const payload = (context.params as AuthenticatedParams).authentication?.payload;
  return (
    isBranchExecutorServicePayload(payload) &&
    payload.branch_id === branchId &&
    (payload.command === 'git.branch.add' || payload.command === 'unix.sync-branch')
  );
}

/** Canonical runtime boundary for every externally transported branch patch. */
export function validateBranchExternalManagedWrite(
  params: AuthenticatedParams,
  branchId: string,
  data: Partial<Branch>,
  options: { allowExecutorReports: boolean } = { allowExecutorReports: true }
): void {
  if (!params.provider) return;
  const fields = Object.keys(data);
  const immutableField = BRANCH_IMMUTABLE_FIELDS.find((field) => fields.includes(field));
  if (immutableField) {
    throw new BadRequest(
      `Branch field '${immutableField}' is assigned at creation and is immutable`
    );
  }

  const archiveField = BRANCH_ARCHIVE_LIFECYCLE_FIELDS.find((field) => fields.includes(field));
  if (archiveField) {
    throw new BadRequest(
      `Branch field '${archiveField}' is managed by archive lifecycle operations`
    );
  }

  const filesystemFields = BRANCH_FILESYSTEM_LIFECYCLE_FIELDS.filter((field) =>
    fields.includes(field)
  );
  if (filesystemFields.length > 0) {
    const capability = options.allowExecutorReports
      ? getBranchFilesystemLifecycleCapability(params, branchId)
      : null;
    const status = data.filesystem_status;
    const statusAllowed =
      status === undefined ||
      (capability?.kind === 'create' && (status === 'ready' || status === 'failed')) ||
      (capability?.kind === 'delete' && (status === 'deleted' || status === 'delete_failed'));
    const forbiddenField = filesystemFields.find((field) => field === 'filesystem_operation_id');
    if (!capability || forbiddenField || !statusAllowed) {
      throw new BadRequest(
        `Branch field '${forbiddenField ?? filesystemFields[0]}' is managed by branch-scoped filesystem lifecycle operations`
      );
    }
  }

  const serverManagedFields = BRANCH_SERVER_MANAGED_FIELDS.filter((field) =>
    fields.includes(field)
  );
  const context = { params } as HookContext;
  const forbiddenServerManagedField = serverManagedFields.find(
    (field) =>
      field !== 'unix_group' ||
      !options.allowExecutorReports ||
      !isBranchUnixGroupExecutorRequest(context, branchId)
  );
  if (forbiddenServerManagedField) {
    throw new BadRequest(`Branch field '${forbiddenServerManagedField}' is managed by the daemon`);
  }
}

/** Whether this request carries a validated executor-session scope. */
export function hasExecutorRuntimeScope(context: HookContext): boolean {
  return scopedPayload(context) !== null;
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

async function requireRepoReadScope(
  context: HookContext,
  id: string | undefined,
  scope: Scope
): Promise<void> {
  if (context.method !== 'get' || !id) {
    throw new Forbidden('Executor token is not valid for this endpoint');
  }

  const branchId = expectClaim(scope.branchId, 'branch') as BranchID;
  // Resolve the allowed repo from the token-scoped branch under the request's
  // trusted tenant context. Never authorize from the client-supplied repo id.
  const branch = await context.app.service('branches').get(branchId, {
    ...context.params,
    provider: undefined,
  });
  expectExistingMatch(String(branch.repo_id), id, 'repo');
}

type AuthHook = (context: HookContext) => Promise<HookContext>;

export function scopeExecutorRuntimeAuth(requireAuth: AuthHook): AuthHook {
  return async (context: HookContext): Promise<HookContext> => {
    const authenticated = await requireAuth(context);
    return executorRuntimeScopeGuard()(authenticated);
  };
}

/** Require this transport call to carry a task-scoped executor session token. */
export function requireExecutorRuntimeToken() {
  return async (context: HookContext): Promise<HookContext> => {
    if (!scopedPayload(context)) {
      throw new Forbidden('A task-scoped executor token is required for this request');
    }
    return context;
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
    // Only police calls that arrive over the executor's transport. Internal
    // server-side service composition (provider undefined) is trusted: route
    // handlers the executor legitimately reached fan out to other services
    // (e.g. the session MCP-servers route reads `mcp-servers`) while carrying
    // the executor's auth in `params`. Re-scoping those would reject paths
    // that are intentionally not in this guard's allow-list.
    if (!(context.params as Params).provider) return context;

    const payload = scopedPayload(context);
    if (!payload) return context;

    const scope = {
      sessionId: getExecutorSessionTokenSessionId(payload),
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
    } else if (path === 'repos') {
      await requireRepoReadScope(context, id, scope);
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
    } else if (path === 'mcp-servers/oauth-auth-headers') {
      // This executor-only endpoint validates the submitted session token and
      // limits returned headers to MCP servers in that session's effective
      // scope. Let only its read-like create operation reach that validation.
      if (context.method !== 'create') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
    } else if (path === 'config/resolve-api-key') {
      if (context.method !== 'create') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
      const taskId = expectClaim(scope.taskId, 'task');
      expectMatch(taskId, data.taskId ?? data.task_id, 'task');
      setIfAbsent(data, 'taskId', taskId);
    } else {
      throw new Forbidden('Executor token is not valid for this endpoint');
    }

    return context;
  };
}
