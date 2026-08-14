import { BadRequest, Forbidden } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Branch,
  BranchID,
  ExecutorServiceTokenPayload,
  HookContext,
  Params,
  RepoFilesystemOperationID,
} from '@agor/core/types';
import {
  BRANCH_ARCHIVE_LIFECYCLE_FIELDS,
  BRANCH_DELETION_EXECUTOR_PATCH_FIELDS,
  BRANCH_FILESYSTEM_LIFECYCLE_FIELDS,
  BRANCH_IMMUTABLE_FIELDS,
  BRANCH_MATERIALIZATION_EXECUTOR_PATCH_FIELDS,
  BRANCH_SERVER_MANAGED_FIELDS,
  BRANCH_UNIX_SYNC_EXECUTOR_PATCH_FIELDS,
  isExecutorServiceTokenPayload,
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

type BranchExecutorServicePayload = ExecutorServiceTokenPayload & { branch_id: string };

export type RepoExecutorServicePayload = ExecutorServiceTokenPayload & {
  repo_id: string;
  filesystem_operation_id?: RepoFilesystemOperationID;
};

export function isRepoExecutorServicePayload(value: unknown): value is RepoExecutorServicePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<RepoExecutorServicePayload>;
  return isExecutorServiceTokenPayload(payload) && typeof payload.repo_id === 'string';
}

export function getRepoExecutorServicePayload(
  params: AuthenticatedParams,
  repoId?: string
): RepoExecutorServicePayload | null {
  const payload = params.authentication?.payload;
  if (!isRepoExecutorServicePayload(payload)) return null;
  if (repoId !== undefined && payload.repo_id !== repoId) return null;
  return payload;
}

function isBranchExecutorServicePayload(value: unknown): value is BranchExecutorServicePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<BranchExecutorServicePayload>;
  return isExecutorServiceTokenPayload(payload) && typeof payload.branch_id === 'string';
}

function isBranchDeletionExecutorSessionPayload(
  value: ExecutorSessionTokenPayload | null,
  branchId: string
): value is ExecutorSessionTokenPayload & { filesystem_operation_id: string } {
  return Boolean(
    value?.branch_id === branchId &&
      value.task_id === undefined &&
      typeof value.filesystem_operation_id === 'string' &&
      (value.session_id === 'branch-delete' || value.session_id === 'branch-remove')
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
  if (isBranchDeletionExecutorSessionPayload(executorPayload, branchId)) {
    return {
      kind: 'delete',
      operationId: executorPayload.filesystem_operation_id,
      metadataRemovalAllowed: executorPayload.session_id === 'branch-remove',
    };
  }
  const payload = params.authentication?.payload;
  if (
    isBranchExecutorServicePayload(payload) &&
    payload.branch_id === branchId &&
    typeof payload.filesystem_operation_id === 'string'
  ) {
    if (payload.command === 'git.branch.add') {
      return { kind: 'create', operationId: payload.filesystem_operation_id };
    }
    if (payload.command === 'git.branch.remove') {
      return {
        kind: 'delete',
        operationId: payload.filesystem_operation_id,
        metadataRemovalAllowed: false,
      };
    }
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
  if (!isExecutorServiceTokenPayload(payload)) return false;
  if (payload.command === 'unix.sync-board') {
    // Board scope requires a branch lookup, which the global capability guard
    // performs before setting this request-local authorization marker.
    return hasAuthorizedExecutorServiceCapability(context.params);
  }
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

  // Even fields ordinarily editable by a branch owner are outside an
  // operation token's authority. Keep this final so more specific immutable
  // and lifecycle diagnostics above remain useful to operators.
  const servicePayload = params.authentication?.payload;
  if (
    isExecutorServiceTokenPayload(servicePayload) &&
    !branchServicePatchMatchesCapability(
      servicePayload,
      branchId,
      data as Record<string, unknown>,
      hasAuthorizedExecutorServiceCapability(params)
    )
  ) {
    throw new Forbidden(
      `Executor service capability '${servicePayload.command}' cannot patch this branch`
    );
  }
  const executorPayload = scopedPayload({ params } as HookContext);
  if (
    isBranchDeletionExecutorSessionPayload(executorPayload, branchId) &&
    !patchUsesOnlyFields(data as Record<string, unknown>, BRANCH_DELETION_EXECUTOR_PATCH_FIELDS)
  ) {
    throw new Forbidden('Branch deletion credential cannot patch client-managed branch fields');
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

function patchUsesOnlyFields(
  data: Record<string, unknown> | null,
  allowedFields: readonly PropertyKey[]
): boolean {
  if (!data) return false;
  const fields = Object.keys(data);
  return fields.length > 0 && fields.every((field) => allowedFields.includes(field));
}

/** Shared field/resource contract for every externally transported branch patch. */
function branchServicePatchMatchesCapability(
  payload: ExecutorServiceTokenPayload,
  branchId: string,
  data: Record<string, unknown>,
  boardScopeAuthorized = false
): boolean {
  if (payload.command === 'git.branch.add') {
    return (
      payloadAllowsBranch(payload, branchId) &&
      patchUsesOnlyFields(data, BRANCH_MATERIALIZATION_EXECUTOR_PATCH_FIELDS)
    );
  }
  if (payload.command === 'git.branch.remove') {
    return (
      payloadAllowsBranch(payload, branchId) &&
      patchUsesOnlyFields(data, BRANCH_DELETION_EXECUTOR_PATCH_FIELDS)
    );
  }
  if (payload.command === 'unix.sync-branch') {
    return (
      payloadAllowsBranch(payload, branchId) &&
      patchUsesOnlyFields(data, BRANCH_UNIX_SYNC_EXECUTOR_PATCH_FIELDS)
    );
  }
  return (
    payload.command === 'unix.sync-board' &&
    boardScopeAuthorized &&
    patchUsesOnlyFields(data, BRANCH_UNIX_SYNC_EXECUTOR_PATCH_FIELDS)
  );
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

const EXECUTOR_SERVICE_CAPABILITY_AUTHORIZED = Symbol('executorServiceCapabilityAuthorized');

export function hasAuthorizedExecutorServiceCapability(params: Params | undefined): boolean {
  return Boolean(
    (params as (Params & { [EXECUTOR_SERVICE_CAPABILITY_AUTHORIZED]?: boolean }) | undefined)?.[
      EXECUTOR_SERVICE_CAPABILITY_AUTHORIZED
    ]
  );
}

function requestId(context: HookContext): string | undefined {
  return typeof context.id === 'string' ? context.id : routeId(context);
}

function servicePayload(context: HookContext): ExecutorServiceTokenPayload | null {
  const raw = (context.params as AuthenticatedParams).authentication?.payload as
    | Record<string, unknown>
    | undefined;
  if (raw?.type !== 'service' || raw.sub !== 'executor-service') return null;
  // Terminal tokens share the JWT strategy but are deliberately not service
  // capabilities and do not call Feathers services.
  if (raw.role === 'terminal-executor' || typeof raw.terminal_user_id === 'string') return null;
  if (!isExecutorServiceTokenPayload(raw)) {
    throw new Forbidden('Executor service token is missing a recognized command capability');
  }
  return raw;
}

function payloadAllowsBranch(payload: ExecutorServiceTokenPayload, branchId: string): boolean {
  return (
    payload.branch_id === branchId ||
    (Array.isArray(payload.branch_ids) && payload.branch_ids.includes(branchId))
  );
}

async function loadBranchForServiceCapability(
  context: HookContext,
  branchId: string
): Promise<{ repo_id?: string; board_id?: string } | null> {
  try {
    return (await context.app.service('branches').get(branchId, {
      ...context.params,
      provider: undefined,
    })) as { repo_id?: string; board_id?: string };
  } catch {
    return null;
  }
}

async function branchMatchesServiceScope(
  context: HookContext,
  payload: ExecutorServiceTokenPayload,
  branchId: string
): Promise<boolean> {
  if (payloadAllowsBranch(payload, branchId)) return true;
  if (!payload.repo_id && !payload.board_id) return false;
  const branch = await loadBranchForServiceCapability(context, branchId);
  return Boolean(
    branch &&
      ((payload.repo_id !== undefined && branch.repo_id === payload.repo_id) ||
        (payload.board_id !== undefined && branch.board_id === payload.board_id))
  );
}

const EXACT_BRANCH_READ_COMMANDS = new Set<ExecutorServiceTokenPayload['command']>([
  'git.branch.add',
  'git.branch.remove',
  'branch.files.list',
  'branch.files.browse',
  'branch.files.read',
  'branch.filesystem.status',
  'branch.artifact.publish',
  'branch.artifact.land',
  'branch.artifact.validate',
  'branch.knowledge.write',
  'branch.knowledge.read',
  'branch.gateway.slack-file-upload',
  'branch.upload.materialize',
  'branch.agor-yml.import',
  'branch.agor-yml.export',
  'unix.sync-branch',
]);

async function executorServiceRequestIsAllowed(
  context: HookContext,
  payload: ExecutorServiceTokenPayload
): Promise<boolean> {
  const path = normalizePath(context.path);
  const id = requestId(context);
  const query = ((context.params as Params).query ?? {}) as Record<string, unknown>;
  const data = asRecord(context.data);

  if (path === 'branches') {
    if (context.method === 'find') {
      if (payload.command === 'git.branch.remove') return true;
      if (payload.command === 'git.managed-credentials.reconcile') return true;
      // Repository deletion must prove that none of its branch roots overlap
      // any other tenant-owned branch or repository namespace before it
      // recursively removes them. This is a read-only tenant inventory; every
      // mutation remains bound to the exact signed repo/operation claims.
      if (payload.command === 'git.repo.delete') return true;
      if (payload.command === 'git.clone' || payload.command === 'unix.sync-repo') {
        return query.repo_id === payload.repo_id;
      }
      return false;
    }
    if (!id) return false;
    if (context.method === 'get') {
      if (EXACT_BRANCH_READ_COMMANDS.has(payload.command)) {
        return payloadAllowsBranch(payload, id);
      }
      if (payload.command === 'unix.sync-board') {
        return branchMatchesServiceScope(context, payload, id);
      }
      return false;
    }
    if (context.method === 'patch') {
      if (payload.command === 'unix.sync-board') {
        return branchServicePatchMatchesCapability(
          payload,
          id,
          data ?? {},
          await branchMatchesServiceScope(context, payload, id)
        );
      }
      return branchServicePatchMatchesCapability(payload, id, data ?? {});
    }
    return false;
  }

  if (path === 'repos') {
    if (context.method === 'find') {
      return (
        payload.command === 'git.branch.remove' ||
        payload.command === 'git.repo.delete' ||
        payload.command === 'git.managed-credentials.reconcile'
      );
    }
    if (!id) return false;
    if (context.method === 'get') {
      if (payload.repo_id === id) return true;
      if (payload.command === 'unix.sync-branch' && payload.branch_id) {
        const branch = await loadBranchForServiceCapability(context, payload.branch_id);
        return branch?.repo_id === id;
      }
      if (payload.command === 'unix.sync-board' && payload.board_id) {
        const branches = await context.app.service('branches').find({
          ...context.params,
          provider: undefined,
          query: { repo_id: id, board_id: payload.board_id, $limit: 1 },
        });
        const rows = Array.isArray(branches) ? branches : branches.data;
        return rows.length > 0;
      }
      return false;
    }
    if (context.method === 'patch') {
      return (
        payload.repo_id === id &&
        (payload.command === 'git.clone' || payload.command === 'unix.sync-repo')
      );
    }
    return false;
  }

  if (path === 'users') {
    if (context.method === 'getGitEnvironment') {
      return (
        (payload.command === 'git.clone' || payload.command === 'git.branch.add') &&
        typeof data?.userId === 'string' &&
        data.userId === payload.user_id
      );
    }
    return (
      context.method === 'get' &&
      id === payload.user_id &&
      (payload.command === 'git.clone' ||
        payload.command === 'unix.sync-user' ||
        payload.command === 'unix.sync-repo')
    );
  }

  if (path === 'sessions') {
    if (context.method !== 'find' || typeof query.branch_id !== 'string') return false;
    if (payload.command === 'git.branch.add' || payload.command === 'unix.sync-branch') {
      return query.branch_id === payload.branch_id;
    }
    if (payload.command === 'unix.sync-board') {
      return branchMatchesServiceScope(context, payload, query.branch_id);
    }
    return false;
  }

  if (path === 'branches/:id/owners' || path === 'branches/:id/fs-access-users') {
    if (context.method !== 'find' || !id) return false;
    if (
      payload.command !== 'git.clone' &&
      payload.command !== 'git.branch.add' &&
      payload.command !== 'unix.sync-repo' &&
      payload.command !== 'unix.sync-branch' &&
      payload.command !== 'unix.sync-board'
    ) {
      return false;
    }
    return branchMatchesServiceScope(context, payload, id);
  }

  if (path === 'boards/:id/aligned-branches') {
    return (
      context.method === 'find' && payload.command === 'unix.sync-board' && id === payload.board_id
    );
  }

  if (path === 'artifacts') {
    if (context.method === 'get') {
      return payload.command === 'branch.artifact.land' && id === payload.artifact_id;
    }
    if (context.method === 'publishFromExecutor' || context.method === 'validateFromExecutor') {
      return (
        (payload.command === 'branch.artifact.publish' ||
          payload.command === 'branch.artifact.validate') &&
        data?.branch_id === payload.branch_id
      );
    }
    return false;
  }

  return false;
}

/**
 * Fail-closed command/resource boundary for every full executor service JWT.
 * Install this as an `all` hook on every Feathers service: a role=`service`
 * identity is never authority by itself.
 */
export function executorServiceCapabilityGuard() {
  return async (context: HookContext): Promise<HookContext> => {
    if (!(context.params as Params).provider) return context;
    const payload = servicePayload(context);
    if (!payload) return context;
    if (!(await executorServiceRequestIsAllowed(context, payload))) {
      throw new Forbidden(
        `Executor service capability '${payload.command}' is not valid for ${normalizePath(context.path)}.${context.method}`
      );
    }
    (
      context.params as Params & {
        [EXECUTOR_SERVICE_CAPABILITY_AUTHORIZED]?: boolean;
      }
    )[EXECUTOR_SERVICE_CAPABILITY_AUTHORIZED] = true;
    return context;
  };
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
