import type { BranchRepository, SessionRepository } from '@agor/core/db';
import { shortId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  Branch,
  BranchPermissionLevel,
  HookContext,
  Session,
  User,
  UUID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { isSuperAdmin, PERMISSION_RANK } from './branch-authorization.js';

type PublishContext = Pick<HookContext, 'path' | 'method' | 'id' | 'event' | 'app'>;

type ConnectionLike = {
  user?: (Partial<User> & { _isServiceAccount?: boolean }) | undefined;
  authentication?: { user?: (Partial<User> & { _isServiceAccount?: boolean }) | undefined };
};

type RealtimePublishOptions = {
  app: Application;
  branchRbacEnabled: boolean;
  branchRepository: BranchRepository;
  sessionsRepository: SessionRepository;
  allowSuperadmin?: boolean;
};

type PublishChannel = ReturnType<Application['channel']>;

type PublishScope =
  | { kind: 'global' }
  | { kind: 'branch'; branch: Branch | null }
  | { kind: 'users'; userIds: Set<string> }
  | { kind: 'serviceOnly' };

const BRANCH_ID_SCOPED_PATHS = new Set(['branches', 'schedules']);
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

function channelConnections(channel: PublishChannel): unknown[] {
  const connections = (channel as { connections?: unknown[] }).connections;
  return Array.isArray(connections) ? connections : [];
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

async function sessionBranch(
  sessionId: string,
  sessionsRepository: SessionRepository,
  branchRepository: BranchRepository
): Promise<Branch | null> {
  const session = (await sessionsRepository.findById(sessionId)) as Session | null;
  if (!session?.branch_id) return null;
  return await branchRepository.findById(session.branch_id);
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

async function resolveBranchFromSessionTaskOrMessage(
  data: unknown,
  context: PublishContext,
  branchRepository: BranchRepository,
  sessionsRepository: SessionRepository
): Promise<Branch | null | undefined> {
  const sessionId = extractSessionId(data);
  if (sessionId) return await sessionBranch(sessionId, sessionsRepository, branchRepository);

  const taskId = extractTaskId(data);
  if (taskId) {
    const resolvedSessionId = await taskSessionId(context, taskId);
    return resolvedSessionId
      ? await sessionBranch(resolvedSessionId, sessionsRepository, branchRepository)
      : null;
  }

  const messageId = extractMessageId(data);
  if (messageId) {
    const resolvedSessionId = await messageSessionId(context, messageId);
    return resolvedSessionId
      ? await sessionBranch(resolvedSessionId, sessionsRepository, branchRepository)
      : null;
  }

  return undefined;
}

async function resolvePublishScope(
  data: unknown,
  context: PublishContext,
  branchRepository: BranchRepository,
  sessionsRepository: SessionRepository
): Promise<PublishScope> {
  if (!context.path) return { kind: 'global' };

  if (BRANCH_ID_SCOPED_PATHS.has(context.path)) {
    const branchId = extractBranchId(data, context);
    return { kind: 'branch', branch: branchId ? await branchRepository.findById(branchId) : null };
  }

  if (context.path === 'sessions') {
    const branchId = extractBranchId(data, context);
    if (branchId) return { kind: 'branch', branch: await branchRepository.findById(branchId) };

    // Custom sessions events carry camelCase `sessionId` instead of the
    // session row's `branch_id`.
    const branch = await resolveBranchFromSessionTaskOrMessage(
      data,
      context,
      branchRepository,
      sessionsRepository
    );
    return { kind: 'branch', branch: branch ?? null };
  }

  if (SESSION_ID_SCOPED_PATHS.has(context.path)) {
    const branch = await resolveBranchFromSessionTaskOrMessage(
      data,
      context,
      branchRepository,
      sessionsRepository
    );
    return { kind: 'branch', branch: branch ?? null };
  }

  if (OPTIONAL_BRANCH_OR_SESSION_SCOPED_PATHS.has(context.path)) {
    const branchId = extractBranchId(data, context);
    if (branchId) return { kind: 'branch', branch: await branchRepository.findById(branchId) };

    const branch = await resolveBranchFromSessionTaskOrMessage(
      data,
      context,
      branchRepository,
      sessionsRepository
    );
    if (branch !== undefined) return { kind: 'branch', branch };

    // These services can also emit global/card/board rows with no branch,
    // session, task, or message attachment.
    return { kind: 'global' };
  }

  if (context.path === 'artifacts') {
    const branchId = extractBranchId(data, context);
    if (branchId) return { kind: 'branch', branch: await branchRepository.findById(branchId) };

    // Null-branch artifacts are not covered by branch visibility. Keep delivery
    // narrow to the creator/admins when the creator is known, otherwise service
    // connections only.
    const createdBy = extractCreatedBy(data);
    return createdBy ? { kind: 'users', userIds: new Set([createdBy]) } : { kind: 'serviceOnly' };
  }

  return { kind: 'global' };
}

async function authorizedConnectedUserIdsForBranch(
  branch: Branch,
  connections: unknown[],
  branchRepository: BranchRepository,
  allowSuperadmin: boolean
): Promise<Set<string>> {
  const allowed = new Set<string>();
  const usersById = new Map<string, Partial<User> & { _isServiceAccount?: boolean }>();

  for (const connection of connections) {
    const user = userFromConnection(connection);
    if (typeof user?.user_id === 'string') usersById.set(user.user_id, user);
  }

  await Promise.all(
    Array.from(usersById.values()).map(async (user) => {
      if (isSuperAdmin(user.role, allowSuperadmin)) {
        allowed.add(user.user_id!);
        return;
      }

      const permission = (await branchRepository.resolveUserPermission(
        branch,
        user.user_id as UUID
      )) as BranchPermissionLevel;
      if (PERMISSION_RANK[permission] >= PERMISSION_RANK.view) {
        allowed.add(user.user_id!);
      }
    })
  );

  return allowed;
}

function filterToServiceConnections(authenticated: PublishChannel): PublishChannel {
  return authenticated.filter((connection: unknown) => isServiceConnection(connection));
}

function filterToBranchUserIds(
  authenticated: PublishChannel,
  userIds: Set<string>
): PublishChannel {
  return authenticated.filter((connection: unknown) => {
    if (isServiceConnection(connection)) return true;
    const userId = userFromConnection(connection)?.user_id;
    return typeof userId === 'string' && userIds.has(userId);
  });
}

function filterToUserIdsOrAdmins(
  authenticated: PublishChannel,
  userIds: Set<string>,
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
    allowSuperadmin = true,
  } = options;

  app.publish(async (data: unknown, context: HookContext) => {
    if (context.path && context.method && !isStreamingEvent(context)) {
      console.log(
        `📡 [Publish] ${context.path} ${context.method}`,
        context.id
          ? `id: ${typeof context.id === 'string' ? shortId(context.id) : context.id}`
          : '',
        `channels: ${app.channel('authenticated').length}`
      );
    }

    const authenticated = app.channel('authenticated');
    if (!branchRbacEnabled) return authenticated;

    const scope = await resolvePublishScope(data, context, branchRepository, sessionsRepository);
    if (scope.kind === 'global') return authenticated;
    if (scope.kind === 'serviceOnly') return filterToServiceConnections(authenticated);
    if (scope.kind === 'users') {
      return filterToUserIdsOrAdmins(authenticated, scope.userIds, allowSuperadmin);
    }

    if (!scope.branch) {
      console.warn('[realtime] Suppressing scoped event without resolvable branch context', {
        path: context.path,
        event: context.event,
        method: context.method,
      });
      return filterToServiceConnections(authenticated);
    }

    const allowedUserIds = await authorizedConnectedUserIdsForBranch(
      scope.branch,
      channelConnections(authenticated),
      branchRepository,
      allowSuperadmin
    );

    return filterToBranchUserIds(authenticated, allowedUserIds);
  });
}
