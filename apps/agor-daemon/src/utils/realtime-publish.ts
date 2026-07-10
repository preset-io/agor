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

/**
 * Per-session channel that carries only the high-frequency streaming events
 * (message text/thinking chunks, tool start/complete). Connections join this
 * room via the `session-streams` service after passing a session-access check,
 * so streaming traffic reaches only the tabs actively viewing a session
 * instead of the whole tenant. Session ids are globally-unique UUIDv7, so the
 * unprefixed name cannot collide across tenants; cross-tenant membership is
 * additionally impossible because the subscribe path gates on a tenant-scoped
 * `sessions.get`.
 */
const SESSION_STREAM_CHANNEL_PREFIX = 'session-stream:';

export function sessionStreamChannelName(sessionId: string): string {
  return `${SESSION_STREAM_CHANNEL_PREFIX}${sessionId}`;
}

/**
 * Remove a connection from every session-stream room it has joined. Called on
 * logout so a still-connected-but-deauthenticated socket stops receiving live
 * session text — Feathers only auto-drops channel membership on socket
 * disconnect, and streaming delivery would otherwise keep reaching a logged-out
 * connection (which is no longer in the authenticated/tenant channels but may
 * still sit in a session-stream room).
 */
export function leaveAllSessionStreamChannels(app: Application, connection: unknown): void {
  for (const name of app.channels ?? []) {
    if (name.startsWith(SESSION_STREAM_CHANNEL_PREFIX)) {
      app.channel(name).leave(connection as never);
    }
  }
}

/**
 * Return an existing channel by name, or null if it has never been created.
 * Feathers' channel lookup MATERIALIZES the channel when absent — and a channel
 * with no joined connection is never auto-cleaned (Feathers only prunes on the
 * last leave) — so the publish path must not touch a room that has no
 * subscribers. Only `session-streams.create` (a real join) should create the
 * room; joined channels get Feathers' empty-cleanup on leave/disconnect.
 */
function existingChannel(app: Application, name: string): PublishChannel | null {
  return (app.channels ?? []).includes(name) ? app.channel(name) : null;
}

/**
 * Join a connection to a session's streaming room. Centralized here (the
 * tenant-aware realtime facade) so subscribe/publish share one channel name
 * and the raw `app.channel` surface stays in a single audited file.
 */
export function joinSessionStreamChannel(
  app: Application,
  sessionId: string,
  connection: unknown
): void {
  app.channel(sessionStreamChannelName(sessionId)).join(connection as never);
}

/**
 * Remove a connection from a session's streaming room, but only if the room
 * already exists. A `remove` for a never-joined room (any authenticated caller
 * can send one) or a dispose after logout/disconnect already pruned the room
 * would otherwise re-materialize an empty, never-cleaned channel — the same
 * leak class as the publish path. `.leave` on an absent room is a no-op anyway.
 */
export function leaveSessionStreamChannel(
  app: Application,
  sessionId: string,
  connection: unknown
): void {
  existingChannel(app, sessionStreamChannelName(sessionId))?.leave(connection as never);
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

// High-frequency per-chunk events emitted on the `messages` service during a
// streaming turn (text + thinking deltas). These fan out once per token-batch,
// so they must be scoped to session subscribers rather than the whole tenant.
const MESSAGE_STREAMING_EVENTS = new Set([
  'streaming:start',
  'streaming:chunk',
  'streaming:end',
  'streaming:error',
  'thinking:start',
  'thinking:chunk',
  'thinking:end',
]);

// Per-chunk / per-tool events emitted on the `tasks` service during a turn.
const TASK_STREAMING_EVENTS = new Set(['thinking:chunk', 'tool:start', 'tool:complete']);

function isStreamingEvent(context: PublishContext): boolean {
  if (context.path === 'messages/streaming') return true;
  const event = context.event;
  if (!event) return false;
  if (context.path === 'messages') {
    return event.startsWith('streaming:') || MESSAGE_STREAMING_EVENTS.has(event);
  }
  if (context.path === 'tasks') {
    return TASK_STREAMING_EVENTS.has(event);
  }
  return false;
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

/**
 * Delivery set for a streaming event. Streaming chunks are the dominant
 * always-on realtime cost, so they bypass the tenant-wide broadcast and go to:
 *
 *   1. the per-session stream room — connections that explicitly subscribed
 *      (session panels / transcripts that passed a session-access check),
 *   2. service connections — gateway / Slack streaming and other service
 *      consumers keep working exactly as before,
 *   3. the session owner's own connections — a cheap fallback so a creator's
 *      already-open tabs keep updating during deploy skew, before a
 *      stale-cached client has re-subscribed after refresh.
 *
 * Authorization is enforced at PUBLISH time, not just at subscribe time: when
 * branch RBAC is on, room members AND the owner fallback are filtered through
 * the current cached branch visibility, so a viewer whose access is revoked
 * mid-stream stops receiving chunks on the very next event (rather than waiting
 * for unsubscribe / disconnect). The cache keeps this per-chunk cost cheap, and
 * room membership is small. With RBAC off there is no visibility model, so
 * subscription + owner + service delivery stands.
 *
 * Everything else (created/patched/removed, status transitions) keeps its
 * existing tenant/branch scoping. Malformed events without a resolvable
 * session id fail closed to service connections only.
 */
async function resolveStreamingDelivery(
  app: Application,
  data: unknown,
  tenantScoped: PublishChannel,
  accessCache: RealtimeAccessCache,
  branchRbacEnabled: boolean,
  allowSuperadmin: boolean
): Promise<PublishChannel | PublishChannel[]> {
  const serviceConnections = filterToServiceConnections(tenantScoped);
  const sessionId = extractSessionId(data);
  if (!sessionId) return serviceConnections;

  // Intersect the room with the tenant/auth channel: a connection that logged
  // out (removed from authenticated + tenant channels) or was tenant-evicted
  // but is still socket-connected may linger in a session-stream room, so this
  // structurally guarantees nothing outside the current tenant/auth set can
  // receive — independent of the per-connection room cleanup on logout.
  const tenantConnections = new Set<unknown>(
    (tenantScoped as unknown as { connections: unknown[] }).connections
  );
  // Never materialize the room on the publish path — a session streaming with
  // zero subscribers would otherwise accumulate an empty, never-cleaned channel
  // per session. Only an actual subscribe (join) creates it.
  const existingRoom = existingChannel(app, sessionStreamChannelName(sessionId));
  const room = existingRoom
    ? existingRoom.filter((connection: unknown) => tenantConnections.has(connection))
    : null;

  let ownerId: string | null = null;
  try {
    ownerId = await accessCache.getSessionOwnerId(sessionId);
  } catch {
    // Best-effort owner fallback; the session room + service connections still
    // deliver even if the owner lookup fails.
  }
  const ownerChannel = (): PublishChannel =>
    tenantScoped.filter(
      (connection: unknown) => userFromConnection(connection)?.user_id === ownerId
    );

  // RBAC off: no visibility model — deliver to subscribers + owner + service.
  if (!branchRbacEnabled) {
    const channels: PublishChannel[] = [serviceConnections];
    if (room) channels.push(room);
    if (ownerId) channels.push(ownerChannel());
    return channels;
  }

  // RBAC on: enforce CURRENT branch visibility at publish time. Resolving the
  // branch/visibility fails closed to service connections if unknown.
  const branchId = await accessCache.getBranchIdForSession(sessionId);
  const visibility = branchId ? await accessCache.getBranchVisibility(branchId) : null;
  if (!visibility) return serviceConnections;

  if (visibility.mode === 'allAuthenticated') {
    const channels: PublishChannel[] = [serviceConnections];
    if (room) channels.push(room);
    if (ownerId) channels.push(ownerChannel());
    return channels;
  }

  // Explicit-users branch: room members and the owner fallback must currently
  // hold view access (service accounts and superadmins always pass).
  const channels: PublishChannel[] = [serviceConnections];
  if (room) {
    channels.push(filterToUserIdsOrSuperadmins(room, visibility.userIds, allowSuperadmin));
  }
  if (ownerId && visibility.userIds.has(ownerId as UserID)) {
    channels.push(ownerChannel());
  }
  return channels;
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
    // Streaming events are routed to session subscribers (plus service and
    // owner connections) regardless of branch RBAC — this is the always-on
    // firehose the tenant broadcast must not carry.
    if (isStreamingEvent(context)) {
      return resolveStreamingDelivery(
        app,
        data,
        tenantScoped,
        accessCache,
        branchRbacEnabled,
        allowSuperadmin
      );
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
