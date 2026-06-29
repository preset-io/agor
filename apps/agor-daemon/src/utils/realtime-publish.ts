import {
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import type { BranchRepository, SessionRepository } from '@agor/core/db';
import { getCurrentTenantId, shortId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, HookContext, User, UserID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { isSuperAdmin } from './branch-authorization.js';
import {
  type RealtimeAccessBranchRepository,
  RealtimeAccessCache,
  type RealtimeAccessSessionRepository,
} from './realtime-access-cache.js';

function tenantChannelName(tenantId: string): string {
  return `tenant:${tenantId}`;
}

const DEBUG_REALTIME_PUBLISH =
  process.env.AGOR_DEBUG_REALTIME_PUBLISH === '1' ||
  process.env.DEBUG?.includes('realtime-publish');

function realtimePublishDebug(...args: unknown[]): void {
  if (DEBUG_REALTIME_PUBLISH) {
    console.debug(...args);
  }
}

type PublishContext = Pick<HookContext, 'path' | 'method' | 'id' | 'event' | 'app' | 'params'>;

type ConnectionLike = {
  user?: (Partial<User> & { _isServiceAccount?: boolean }) | undefined;
  authentication?: { user?: (Partial<User> & { _isServiceAccount?: boolean }) | undefined };
};

type RealtimePublishOptions = {
  app: Application;
  branchRbacEnabled: boolean;
  branchRepository: BranchRepository;
  sessionsRepository: SessionRepository;
  accessCache?: RealtimeAccessCache;
  allowSuperadmin?: boolean;
  multiTenancy?: ResolvedMultiTenancyConfig;
};

type PublishChannel = ReturnType<Application['channel']>;

type PublishScope =
  | { kind: 'global' }
  | { kind: 'branch'; branchId: BranchID | null }
  | { kind: 'users'; userIds: Set<string> }
  | { kind: 'serviceOnly' };

const BRANCH_ID_SCOPED_PATHS = new Set(['branches', 'schedules']);
const ROUTE_BRANCH_ID_SCOPED_PATHS = new Set(['branches/:id/owners', 'branches/:id/group-grants']);
const SESSION_ID_SCOPED_PATHS = new Set([
  'tasks',
  'messages',
  'session-mcp-servers',
  'session-env-selections',
]);
const OPTIONAL_BRANCH_OR_SESSION_SCOPED_PATHS = new Set(['board-objects', 'board-comments']);

function isStreamingEvent(context: PublishContext): boolean {
  return (
    context.path === 'messages/streaming' ||
    (context.path === 'messages' && context.event?.startsWith('streaming:') === true)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(obj: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function extractBranchId(data: unknown, context: PublishContext): string | undefined {
  const record = asRecord(data);
  const routeBranchId = (context.params as { route?: { id?: unknown } } | undefined)?.route?.id;
  if (
    ROUTE_BRANCH_ID_SCOPED_PATHS.has(context.path ?? '') &&
    typeof routeBranchId === 'string' &&
    routeBranchId.length > 0
  ) {
    return routeBranchId;
  }

  if (context.path === 'branches') {
    return (
      pickString(record, 'branch_id', 'branchId') ??
      (typeof context.id === 'string' ? context.id : undefined)
    );
  }
  return pickString(record, 'branch_id', 'branchId');
}

function extractSessionId(data: unknown): string | undefined {
  const record = asRecord(data);
  return pickString(record, 'session_id', 'sessionId');
}

function extractTaskId(data: unknown): string | undefined {
  const record = asRecord(data);
  return pickString(record, 'task_id', 'taskId');
}

function extractMessageId(data: unknown): string | undefined {
  const record = asRecord(data);
  return pickString(record, 'message_id', 'messageId');
}

function extractCreatedBy(data: unknown): string | undefined {
  const record = asRecord(data);
  return pickString(record, 'created_by', 'createdBy');
}

function userFromConnection(
  connection: unknown
): (Partial<User> & { _isServiceAccount?: boolean }) | undefined {
  const c = connection as ConnectionLike | undefined;
  return c?.user ?? c?.authentication?.user;
}

function isServiceConnection(connection: unknown): boolean {
  const user = userFromConnection(connection);
  return user?._isServiceAccount === true || (user?.role as string | undefined) === 'service';
}

function isAdminConnection(connection: unknown, allowSuperadmin: boolean): boolean {
  const user = userFromConnection(connection);
  if (!user?._isServiceAccount && user?.role && hasMinimumRole(user.role, ROLES.ADMIN)) {
    return true;
  }
  return isSuperAdmin(user?.role, allowSuperadmin);
}

async function sessionBranchId(
  sessionId: string,
  accessCache: RealtimeAccessCache
): Promise<BranchID | null> {
  return await accessCache.getBranchIdForSession(sessionId);
}

async function taskSessionId(context: PublishContext, taskId: string): Promise<string | null> {
  try {
    const task = (await context.app.service('tasks').get(taskId, {
      provider: undefined,
    })) as { session_id?: string } | null;
    return task?.session_id ?? null;
  } catch {
    return null;
  }
}

async function messageSessionId(
  context: PublishContext,
  messageId: string
): Promise<string | null> {
  try {
    const message = (await context.app.service('messages').get(messageId, {
      provider: undefined,
    })) as { session_id?: string } | null;
    return message?.session_id ?? null;
  } catch {
    return null;
  }
}

async function resolveBranchIdFromSessionTaskOrMessage(
  data: unknown,
  context: PublishContext,
  accessCache: RealtimeAccessCache
): Promise<BranchID | null | undefined> {
  const branchId = extractBranchId(data, context);
  if (branchId) return branchId as BranchID;

  const sessionId = extractSessionId(data);
  if (sessionId) return await sessionBranchId(sessionId, accessCache);

  const taskId = extractTaskId(data);
  if (taskId) {
    const resolvedSessionId = await taskSessionId(context, taskId);
    return resolvedSessionId ? await sessionBranchId(resolvedSessionId, accessCache) : null;
  }

  const messageId = extractMessageId(data);
  if (messageId) {
    const resolvedSessionId = await messageSessionId(context, messageId);
    return resolvedSessionId ? await sessionBranchId(resolvedSessionId, accessCache) : null;
  }

  return undefined;
}

async function resolveBranchIdFromBranchOrSession(
  data: unknown,
  context: PublishContext,
  accessCache: RealtimeAccessCache
): Promise<BranchID | null | undefined> {
  const branchId = extractBranchId(data, context);
  if (branchId) return branchId as BranchID;

  const sessionId = extractSessionId(data);
  if (sessionId) return await sessionBranchId(sessionId, accessCache);

  return undefined;
}

async function resolvePublishScope(
  data: unknown,
  context: PublishContext,
  accessCache: RealtimeAccessCache
): Promise<PublishScope> {
  if (!context.path) return { kind: 'global' };

  if (BRANCH_ID_SCOPED_PATHS.has(context.path) || ROUTE_BRANCH_ID_SCOPED_PATHS.has(context.path)) {
    const branchId = extractBranchId(data, context);
    return { kind: 'branch', branchId: (branchId as BranchID | undefined) ?? null };
  }

  if (context.path === 'sessions') {
    // Custom sessions events carry camelCase `sessionId` instead of the
    // session row's `branch_id`.
    const resolvedBranchId = await resolveBranchIdFromBranchOrSession(data, context, accessCache);
    return { kind: 'branch', branchId: resolvedBranchId ?? null };
  }

  if (SESSION_ID_SCOPED_PATHS.has(context.path)) {
    // Hot message/task paths must carry branch_id or session_id. Avoid
    // message/task fallback lookups here so malformed streaming events fail
    // closed instead of doing DB work per chunk.
    const branchId = await resolveBranchIdFromBranchOrSession(data, context, accessCache);
    return { kind: 'branch', branchId: branchId ?? null };
  }

  if (OPTIONAL_BRANCH_OR_SESSION_SCOPED_PATHS.has(context.path)) {
    const resolvedBranchId = await resolveBranchIdFromSessionTaskOrMessage(
      data,
      context,
      accessCache
    );
    if (resolvedBranchId !== undefined) return { kind: 'branch', branchId: resolvedBranchId };

    // These services can also emit global/card/board rows with no branch,
    // session, task, or message attachment.
    return { kind: 'global' };
  }

  if (context.path === 'artifacts') {
    const branchId = extractBranchId(data, context);
    if (branchId) return { kind: 'branch', branchId: branchId as BranchID };

    // Null-branch artifacts are not covered by branch visibility. Keep delivery
    // narrow to the creator/admins when the creator is known, otherwise service
    // connections only.
    const createdBy = extractCreatedBy(data);
    return createdBy ? { kind: 'users', userIds: new Set([createdBy]) } : { kind: 'serviceOnly' };
  }

  return { kind: 'global' };
}

function filterToServiceConnections(authenticated: PublishChannel): PublishChannel {
  return authenticated.filter((connection: unknown) => isServiceConnection(connection));
}

function filterToUserIdsOrAdmins(
  authenticated: PublishChannel,
  userIds: Set<string> | Set<UserID>,
  allowSuperadmin: boolean
): PublishChannel {
  return authenticated.filter((connection: unknown) => {
    if (isServiceConnection(connection) || isAdminConnection(connection, allowSuperadmin)) {
      return true;
    }
    const userId = userFromConnection(connection)?.user_id;
    return typeof userId === 'string' && userIds.has(userId);
  });
}

function filterToUserIdsOrSuperadmins(
  authenticated: PublishChannel,
  userIds: Set<UserID>,
  allowSuperadmin: boolean
): PublishChannel {
  return authenticated.filter((connection: unknown) => {
    if (isServiceConnection(connection)) return true;
    const user = userFromConnection(connection);
    if (isSuperAdmin(user?.role, allowSuperadmin)) return true;
    const userId = user?.user_id;
    return typeof userId === 'string' && userIds.has(userId as UserID);
  });
}

function extractConnectionTenantId(context: HookContext): string | undefined {
  const params = context.params as
    | {
        connection?: {
          tenant?: unknown;
          data?: { tenant?: unknown };
        };
      }
    | undefined;
  const tenant = params?.connection?.tenant ?? params?.connection?.data?.tenant;
  return tenant && typeof tenant === 'object' && 'tenant_id' in tenant
    ? typeof tenant.tenant_id === 'string'
      ? tenant.tenant_id
      : undefined
    : undefined;
}

function resolveRealtimeTenantId(multiTenancy: ResolvedMultiTenancyConfig, context: HookContext) {
  try {
    return resolveTenantContext(multiTenancy, { params: context.params }).tenant_id;
  } catch (error) {
    const connectionTenantId = extractConnectionTenantId(context);
    if (error instanceof TenantResolutionError && connectionTenantId) return connectionTenantId;

    const ambientTenantId = getCurrentTenantId();
    if (error instanceof TenantResolutionError && ambientTenantId) return ambientTenantId;
    throw error;
  }
}

/**
 * Register the single global Feathers publish handler.
 *
 * In open-access mode this preserves the legacy behavior: every authenticated
 * socket receives every service event. When branch RBAC is enabled, events for
 * branch/session-scoped resources are reduced to authenticated connections whose
 * user currently has at least `view` permission for the event's branch. Service
 * executor sockets remain trusted so prompt/permission plumbing keeps working.
 */
export function configureRealtimePublish(options: RealtimePublishOptions): void {
  const {
    app,
    branchRbacEnabled,
    branchRepository,
    sessionsRepository,
    accessCache = new RealtimeAccessCache({
      branchRepository: branchRepository as unknown as RealtimeAccessBranchRepository,
      sessionsRepository: sessionsRepository as unknown as RealtimeAccessSessionRepository,
    }),
    allowSuperadmin = true,
    multiTenancy,
  } = options;

  app.publish(async (data: unknown, context: HookContext) => {
    if (context.path && context.method && !isStreamingEvent(context)) {
      realtimePublishDebug(
        `📡 [Publish] ${context.path} ${context.method}`,
        context.id
          ? `id: ${typeof context.id === 'string' ? shortId(context.id) : context.id}`
          : '',
        `channels: ${app.channel('authenticated').length}`
      );
    }

    const authenticated = app.channel('authenticated');
    let tenantScoped = authenticated;
    if (multiTenancy) {
      try {
        const tenantId = resolveRealtimeTenantId(multiTenancy, context);
        tenantScoped = app.channel(tenantChannelName(tenantId));
      } catch (error) {
        if (error instanceof TenantResolutionError) {
          console.warn('[realtime] Suppressing event without tenant context', {
            path: context.path,
            event: context.event,
            method: context.method,
          });
          return filterToServiceConnections(authenticated);
        }
        throw error;
      }
    }
    if (!branchRbacEnabled) return tenantScoped;

    const scope = await resolvePublishScope(data, context, accessCache);
    if (scope.kind === 'global') return tenantScoped;
    if (scope.kind === 'serviceOnly') return filterToServiceConnections(tenantScoped);
    if (scope.kind === 'users') {
      return filterToUserIdsOrAdmins(tenantScoped, scope.userIds, allowSuperadmin);
    }

    if (!scope.branchId) {
      console.warn('[realtime] Suppressing scoped event without resolvable branch context', {
        path: context.path,
        event: context.event,
        method: context.method,
      });
      return filterToServiceConnections(tenantScoped);
    }

    const visibility = await accessCache.getBranchVisibility(scope.branchId);
    if (!visibility) {
      console.warn('[realtime] Suppressing scoped event without resolvable branch context', {
        path: context.path,
        event: context.event,
        method: context.method,
      });
      return filterToServiceConnections(tenantScoped);
    }

    if (visibility.mode === 'allAuthenticated') {
      return tenantScoped;
    }

    return filterToUserIdsOrSuperadmins(tenantScoped, visibility.userIds, allowSuperadmin);
  });
}
