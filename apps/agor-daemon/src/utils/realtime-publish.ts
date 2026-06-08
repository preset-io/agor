import type { BranchRepository, SessionRepository, UsersRepository } from '@agor/core/db';
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
import { isSuperAdmin, PERMISSION_RANK } from './branch-authorization.js';

type PublishContext = Pick<HookContext, 'path' | 'method' | 'id' | 'event'>;

type ConnectionLike = {
  user?: (Partial<User> & { _isServiceAccount?: boolean }) | undefined;
  authentication?: { user?: (Partial<User> & { _isServiceAccount?: boolean }) | undefined };
};

type RealtimePublishOptions = {
  app: Application;
  branchRbacEnabled: boolean;
  branchRepository: BranchRepository;
  sessionsRepository: SessionRepository;
  usersRepository: UsersRepository;
  allowSuperadmin?: boolean;
};

const BRANCH_ID_SCOPED_PATHS = new Set(['branches', 'schedules']);
const OPTIONAL_BRANCH_ID_SCOPED_PATHS = new Set(['artifacts', 'board-comments', 'board-objects']);
const SESSION_ID_SCOPED_PATHS = new Set([
  'tasks',
  'messages',
  'session-mcp-servers',
  'session-env-selections',
]);
const OPTIONAL_BRANCH_OR_SESSION_SCOPED_PATHS = new Set([
  'artifacts',
  'board-objects',
  'board-comments',
]);

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

async function resolveBranchForPublish(
  data: unknown,
  context: PublishContext,
  branchRepository: BranchRepository,
  sessionsRepository: SessionRepository
): Promise<Branch | null | undefined> {
  if (!context.path) return undefined;

  if (BRANCH_ID_SCOPED_PATHS.has(context.path)) {
    const branchId = extractBranchId(data, context);
    if (!branchId) return null;
    return await branchRepository.findById(branchId);
  }

  if (OPTIONAL_BRANCH_ID_SCOPED_PATHS.has(context.path)) {
    const branchId = extractBranchId(data, context);
    return branchId ? await branchRepository.findById(branchId) : undefined;
  }

  if (context.path === 'sessions') {
    const branchId = extractBranchId(data, context);
    if (branchId) return await branchRepository.findById(branchId);

    // Custom sessions events (permission:request / permission:timeout) carry
    // camelCase `sessionId` instead of the session row's `branch_id`.
    const sessionId = extractSessionId(data);
    if (!sessionId) return null;
    const session = (await sessionsRepository.findById(sessionId)) as Session | null;
    if (!session?.branch_id) return null;
    return await branchRepository.findById(session.branch_id);
  }

  if (OPTIONAL_BRANCH_OR_SESSION_SCOPED_PATHS.has(context.path)) {
    const branchId = extractBranchId(data, context);
    if (branchId) return await branchRepository.findById(branchId);

    const sessionId = extractSessionId(data);
    if (sessionId) {
      const session = (await sessionsRepository.findById(sessionId)) as Session | null;
      if (!session?.branch_id) return null;
      return await branchRepository.findById(session.branch_id);
    }

    // These services can also emit global/card/board rows with no branch or
    // session attachment. They are not branch-scoped, so keep normal fan-out.
    return undefined;
  }

  if (SESSION_ID_SCOPED_PATHS.has(context.path)) {
    const sessionId = extractSessionId(data);
    if (!sessionId) return null;
    const session = (await sessionsRepository.findById(sessionId)) as Session | null;
    if (!session?.branch_id) return null;
    return await branchRepository.findById(session.branch_id);
  }

  return undefined;
}

function userFromConnection(
  connection: unknown
): (Partial<User> & { _isServiceAccount?: boolean }) | undefined {
  const c = connection as ConnectionLike | undefined;
  return c?.user ?? c?.authentication?.user;
}

async function authorizedUserIdsForBranch(
  branch: Branch,
  usersRepository: UsersRepository,
  branchRepository: BranchRepository,
  allowSuperadmin: boolean
): Promise<Set<string>> {
  const users = await usersRepository.findAll();
  const allowed = new Set<string>();

  await Promise.all(
    users.map(async (user) => {
      if (isSuperAdmin(user.role, allowSuperadmin)) {
        allowed.add(user.user_id);
        return;
      }

      const permission = (await branchRepository.resolveUserPermission(
        branch,
        user.user_id as UUID
      )) as BranchPermissionLevel;
      if (PERMISSION_RANK[permission] >= PERMISSION_RANK.view) {
        allowed.add(user.user_id);
      }
    })
  );

  return allowed;
}

function isServiceConnection(connection: unknown): boolean {
  const user = userFromConnection(connection);
  return user?._isServiceAccount === true || (user?.role as string | undefined) === 'service';
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
    usersRepository,
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

    const branch = await resolveBranchForPublish(
      data,
      context,
      branchRepository,
      sessionsRepository
    );

    // Undefined means the service is not branch/session scoped, so keep the
    // regular authenticated fan-out. Null means it should have been scoped but
    // lacked resolvable branch/session context; fail closed to prevent leakage.
    if (branch === undefined) return authenticated;
    if (!branch) {
      console.warn('[realtime] Suppressing scoped event without resolvable branch context', {
        path: context.path,
        event: context.event,
        method: context.method,
      });
      return authenticated.filter((connection: unknown) => isServiceConnection(connection));
    }

    const allowedUserIds = await authorizedUserIdsForBranch(
      branch,
      usersRepository,
      branchRepository,
      allowSuperadmin
    );

    return authenticated.filter((connection: unknown) => {
      if (isServiceConnection(connection)) return true;
      const user = userFromConnection(connection);
      const userId = user?.user_id;
      return typeof userId === 'string' && allowedUserIds.has(userId);
    });
  });
}
