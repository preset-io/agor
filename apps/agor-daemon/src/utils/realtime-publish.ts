import {
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import type { BranchRepository, SessionRepository, TenantScopeAwareDatabase } from '@agor/core/db';
import { getCurrentTenantId, runWithTenantDatabaseScope, shortId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  isBranchRemovalRealtimeVisibilitySnapshot,
  isRealtimeRelayEnvelope,
  MAX_REALTIME_RELAY_BYTES,
  REALTIME_RELAY_VERSION,
  type RealtimeRelayEnvelope,
} from '@agor/core/realtime';
import {
  type BranchID,
  type BranchRealtimeVisibility,
  BranchRealtimeVisibilityMode,
  type BranchRemovalRealtimeVisibilitySnapshot,
  type HookContext,
  hasMinimumRole,
  ROLES,
  type TenantID,
  type User,
  type UserID,
} from '@agor/core/types';
import { tenantChannelName } from '../realtime/routing.js';
import { isSuperAdmin } from './branch-authorization.js';
import {
  isKnowledgeRealtimeSuppressedEvent,
  resolveKnowledgeRealtimeUserIds,
} from './knowledge-realtime-publish.js';
import {
  type RealtimeAccessBranchRepository,
  RealtimeAccessCache,
  type RealtimeAccessSessionRepository,
} from './realtime-access-cache.js';

export const BRANCH_REMOVAL_VISIBILITY_PARAM = '_agorRealtimeBranchRemovalVisibility';

/** Capture the branch visibility fact while its ACL rows still exist. */
export function setBranchRemovalRealtimeVisibility(
  params: HookContext['params'],
  branchId: BranchID,
  visibility: BranchRealtimeVisibility
): void {
  const snapshot: BranchRemovalRealtimeVisibilitySnapshot =
    visibility.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED
      ? { branchId, mode: BranchRealtimeVisibilityMode.ALL_AUTHENTICATED }
      : {
          branchId,
          mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS,
          userIds: [...visibility.userIds].sort(),
        };
  (params as HookContext['params'] & Record<string, unknown>)[BRANCH_REMOVAL_VISIBILITY_PARAM] =
    snapshot;
}

function branchRemovalVisibilitySnapshot(
  context: PublishContext,
  branchId: BranchID
): BranchRemovalRealtimeVisibilitySnapshot | null {
  if (context.path !== 'branches' || context.event !== 'removed') return null;
  const value = (context.params as Record<string, unknown> | undefined)?.[
    BRANCH_REMOVAL_VISIBILITY_PARAM
  ];
  return isBranchRemovalRealtimeVisibilitySnapshot(value) && value.branchId === branchId
    ? value
    : null;
}

function visibilityFromRemovalSnapshot(
  snapshot: BranchRemovalRealtimeVisibilitySnapshot | null
): BranchRealtimeVisibility | null {
  if (!snapshot) return null;
  return snapshot.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED
    ? { mode: BranchRealtimeVisibilityMode.ALL_AUTHENTICATED }
    : {
        mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS,
        userIds: new Set(snapshot.userIds),
      };
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
const EXECUTOR_TASK_CHANNEL_PREFIX = 'executor-task:';

/**
 * Private control-plane room for the one executor JWT scoped to a Task.
 *
 * Unlike normal Task events, membership is not derived from branch visibility:
 * configureChannels joins this room only after ServiceJWTStrategy has verified
 * an `executor-session` token whose signed `task_id` matches the room. There is
 * no client-callable subscribe method.
 */
export function executorTaskChannelName(tenantId: string, taskId: string): string {
  return `${EXECUTOR_TASK_CHANNEL_PREFIX}${tenantId}:${taskId}`;
}

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

/** Drop task-control capability on logout or before replacing socket auth. */
export function leaveAllExecutorTaskChannels(app: Application, connection: unknown): void {
  for (const name of app.channels ?? []) {
    if (name.startsWith(EXECUTOR_TASK_CHANNEL_PREFIX)) {
      app.channel(name).leave(connection as never);
    }
  }
}

/** Drop every tenant-scoped Feathers channel on logout or live auth replacement. */
export function leaveAllTenantChannels(app: Application, connection: unknown): void {
  for (const name of app.channels ?? []) {
    if (name.startsWith('tenant:')) {
      app.channel(name).leave(connection as never);
    }
  }
}

/** Join the private executor control room after the signed task claim is verified. */
export function joinExecutorTaskChannel(
  app: Application,
  tenantId: string,
  taskId: string,
  connection: unknown
): void {
  app.channel(executorTaskChannelName(tenantId, taskId)).join(connection as never);
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
  db?: TenantScopeAwareDatabase;
  branchRbacEnabled: boolean;
  branchRepository: BranchRepository;
  sessionsRepository: SessionRepository;
  accessCache?: RealtimeAccessCache;
  allowSuperadmin?: boolean;
  multiTenancy?: ResolvedMultiTenancyConfig;
  /** Present only in explicit HA mode. Redis transports a minimal safe envelope. */
  realtimeRelay?: {
    relay: (envelope: RealtimeRelayEnvelope) => void;
    setRelayHandler: (handler: (envelope: RealtimeRelayEnvelope) => void | Promise<void>) => void;
  };
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
  // Defense in depth: the route suppresses its duplicate default event and
  // emits canonical `messages.created` events, but a future publication
  // regression must still remain branch-scoped rather than tenant-global.
  'messages/bulk',
  'session-mcp-servers',
  'session-env-selections',
]);
const OPTIONAL_BRANCH_OR_SESSION_SCOPED_PATHS = new Set(['board-objects', 'board-comments']);

// Authentication and credential control-plane results must never enter shared
// Redis, even if a future service accidentally enables publication for them.
export const REDIS_FEATHERS_DENIED_PATHS = new Set([
  'authentication',
  'authentication/refresh',
  'check-auth',
  'session-tokens',
  'user-api-keys',
  'external-launch',
  'config/resolve-api-key',
  'mcp-servers/oauth-start',
  'mcp-servers/oauth-callback',
  'mcp-servers/oauth-complete',
  'mcp-servers/oauth-disconnect',
  'mcp-servers/oauth-status',
  'mcp-servers/oauth-auth-headers',
  'mcp-servers/oauth-refresh',
  'mcp-servers/test-oauth',
  'user-mcp-oauth-tokens',
  'codex-auth/device',
  'codex-auth/import',
  'codex-auth/logout',
  'opencode-auth',
  'terminals',
]);

function mayEnterRedisRelay(path: string, event: string): boolean {
  if (REDIS_FEATHERS_DENIED_PATHS.has(path)) return false;
  if (isKnowledgeRealtimeSuppressedEvent(path, event)) return false;
  // Runtime DOM/status results can contain secret-derived values. CRUD events
  // for Artifact metadata remain ordinary tenant-authorized service payloads.
  if (path === 'artifacts' && event === 'agor-query') return false;
  return true;
}

function safeRelayData(data: unknown): unknown | undefined {
  try {
    const encoded = JSON.stringify(data);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_REALTIME_RELAY_BYTES)
      return undefined;
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

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

/** Per-connection flag: set only by the explicit `{capability:true}` announce (not by a plain subscribe), so the owner fallback skips this connection for all sessions. */
export const SESSION_STREAMS_AWARE_FLAG = '__agorSessionStreamsAware';

/** Set the aware flag. Lives beside the raw `app.channel` surface so realtime-routing mutations stay in one audited place. */
export function markConnectionSessionStreamsAware(connection: unknown): void {
  if (connection && typeof connection === 'object') {
    (connection as Record<string, unknown>)[SESSION_STREAMS_AWARE_FLAG] = true;
  }
}

function isSessionStreamsAware(connection: unknown): boolean {
  return (
    !!connection &&
    typeof connection === 'object' &&
    (connection as Record<string, unknown>)[SESSION_STREAMS_AWARE_FLAG] === true
  );
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

function uniqueUserIds(authenticated: PublishChannel): string[] {
  const userIds = new Set<string>();
  for (const connection of authenticated.connections as unknown[]) {
    if (isServiceConnection(connection)) continue;
    const userId = userFromConnection(connection)?.user_id;
    if (typeof userId === 'string') userIds.add(userId);
  }
  return [...userIds];
}

function filterToUserIdsOrServices(
  authenticated: PublishChannel,
  userIds: Set<string>
): PublishChannel {
  return authenticated.filter((connection: unknown) => {
    if (isServiceConnection(connection)) return true;
    const userId = userFromConnection(connection)?.user_id;
    return typeof userId === 'string' && userIds.has(userId);
  });
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
  // Connections already in THIS session's room receive via the room, so the
  // owner fallback excludes them — room-scoped, not connection-wide (an owner
  // subscribed to A still gets fallback for other owned sessions it never joined).
  const roomConnections = new Set<unknown>(
    room ? (room as unknown as { connections: unknown[] }).connections : []
  );
  // Owner fallback: only owner connections that haven't announced awareness
  // (aware clients get streaming via the room) and aren't in this room. Never widens.
  const ownerChannel = (): PublishChannel =>
    tenantScoped.filter(
      (connection: unknown) =>
        userFromConnection(connection)?.user_id === ownerId &&
        !isSessionStreamsAware(connection) &&
        !roomConnections.has(connection)
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

  if (visibility.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED) {
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
  userIds: ReadonlySet<UserID>,
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

function extractConnectionTenantId(context: HookContext): TenantID | undefined {
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
      ? (tenant.tenant_id as TenantID)
      : undefined
    : undefined;
}

function resolveRealtimeTenantId(
  multiTenancy: ResolvedMultiTenancyConfig,
  context: HookContext
): TenantID {
  try {
    return resolveTenantContext(multiTenancy, { params: context.params }).tenant_id;
  } catch (error) {
    const connectionTenantId = extractConnectionTenantId(context);
    if (error instanceof TenantResolutionError && connectionTenantId) return connectionTenantId;

    const ambientTenantId = getCurrentTenantId();
    if (error instanceof TenantResolutionError && ambientTenantId) {
      return ambientTenantId as TenantID;
    }
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
    db,
    branchRbacEnabled,
    branchRepository,
    sessionsRepository,
    accessCache = new RealtimeAccessCache({
      branchRepository: branchRepository as unknown as RealtimeAccessBranchRepository,
      sessionsRepository: sessionsRepository as unknown as RealtimeAccessSessionRepository,
    }),
    allowSuperadmin = true,
    multiTenancy,
    realtimeRelay,
  } = options;

  const resolveLocalDelivery = async (data: unknown, context: HookContext) => {
    const authenticated = app.channel('authenticated');
    if (context.path && isKnowledgeRealtimeSuppressedEvent(context.path, context.event)) {
      return { delivery: authenticated.filter(() => false), tenantId: undefined };
    }

    let tenantScoped = authenticated;
    let tenantId: TenantID | undefined;
    if (multiTenancy) {
      try {
        tenantId = resolveRealtimeTenantId(multiTenancy, context);
        tenantScoped = app.channel(tenantChannelName(tenantId));
      } catch (error) {
        if (error instanceof TenantResolutionError) {
          console.warn('[realtime] Suppressing event without tenant context', {
            path: context.path,
            event: context.event,
            method: context.method,
          });
          return { delivery: filterToServiceConnections(authenticated), tenantId: undefined };
        }
        throw error;
      }
    }

    const isExecutorControlEvent =
      (context.path === 'tasks' && context.event === 'termination_requested') ||
      (context.path === 'messages' && context.event === 'permission_resolved');
    if (isExecutorControlEvent) {
      const taskId = extractTaskId(data);
      if (!tenantId || !taskId) return { delivery: [] as PublishChannel[], tenantId };
      const room = existingChannel(app, executorTaskChannelName(tenantId, taskId));
      return { delivery: room ? [room] : ([] as PublishChannel[]), tenantId };
    }

    const resolveDelivery = async (): Promise<PublishChannel | PublishChannel[]> => {
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

      const knowledgeUserIds = await resolveKnowledgeRealtimeUserIds({
        app,
        db,
        data,
        context,
        userIds: uniqueUserIds(tenantScoped),
      });
      if (knowledgeUserIds) {
        return filterToUserIdsOrServices(tenantScoped, knowledgeUserIds);
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

      // A hard delete has already committed when Feathers emits `removed`, so
      // the branch/owner/grant rows can no longer authorize the tombstone. Use
      // the server-captured pre-delete fact for this one event; every other
      // branch event continues to authorize from current database state.
      const isBranchRemoval = context.path === 'branches' && context.event === 'removed';
      const visibility = isBranchRemoval
        ? visibilityFromRemovalSnapshot(branchRemovalVisibilitySnapshot(context, scope.branchId))
        : await accessCache.getBranchVisibility(scope.branchId);
      if (!visibility) {
        console.warn('[realtime] Suppressing scoped event without resolvable branch context', {
          path: context.path,
          event: context.event,
          method: context.method,
        });
        return filterToServiceConnections(tenantScoped);
      }
      if (visibility.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED) return tenantScoped;
      return filterToUserIdsOrSuperadmins(tenantScoped, visibility.userIds, allowSuperadmin);
    };

    const delivery =
      db && tenantId
        ? await runWithTenantDatabaseScope(db, tenantId, resolveDelivery)
        : await resolveDelivery();
    if (context.path === 'branches' && context.event === 'removed') {
      const removedBranchId = extractBranchId(data, context);
      if (removedBranchId) accessCache.invalidateBranch(removedBranchId);
    }
    return { delivery, tenantId };
  };

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

    const resolved = await resolveLocalDelivery(data, context);
    if (
      realtimeRelay &&
      resolved.tenantId &&
      context.path &&
      context.event &&
      mayEnterRedisRelay(context.path, context.event)
    ) {
      // Feathers after-hooks may redact a service result by setting dispatch.
      // The local transport prefers that value; Redis must do the same or a
      // gateway/config service could fan out the unredacted event argument.
      const dispatchedData = context.dispatch !== undefined ? context.dispatch : data;
      const relayData = safeRelayData(dispatchedData);
      if (relayData !== undefined) {
        const removedBranchId = extractBranchId(relayData, context) as BranchID | undefined;
        const removalVisibility = removedBranchId
          ? branchRemovalVisibilitySnapshot(context, removedBranchId)
          : null;
        const envelope: RealtimeRelayEnvelope = {
          version: REALTIME_RELAY_VERSION,
          tenantId: resolved.tenantId,
          path: context.path,
          event: context.event,
          ...(context.method ? { method: context.method } : {}),
          ...(typeof context.id === 'string' || typeof context.id === 'number'
            ? { id: context.id }
            : {}),
          data: relayData,
          ...(removalVisibility ? { branchRemovalVisibility: removalVisibility } : {}),
        };
        try {
          if (!isRealtimeRelayEnvelope(envelope)) {
            console.warn('[realtime/redis] publication omitted: envelope is not bounded JSON');
            return resolved.delivery;
          }
          realtimeRelay.relay(envelope);
        } catch {
          // Redis readiness has already turned false. The durable mutation is
          // not rolled back merely because its best-effort notification failed.
          console.warn('[realtime/redis] publication relay unavailable');
        }
      } else {
        console.warn('[realtime/redis] publication omitted: payload is not bounded JSON');
      }
    }
    return resolved.delivery;
  });

  realtimeRelay?.setRelayHandler(async (envelope) => {
    // Never trust the Redis namespace as authorization. Re-run the exact local
    // tenant/RBAC publisher against this replica's own authenticated channels.
    if (!mayEnterRedisRelay(envelope.path, envelope.event)) return;
    const params: HookContext['params'] & Record<string, unknown> = {
      provider: 'socketio-redis-relay',
      tenant: { tenant_id: envelope.tenantId, source: 'explicit' },
    };
    if (envelope.branchRemovalVisibility) {
      params[BRANCH_REMOVAL_VISIBILITY_PARAM] = envelope.branchRemovalVisibility;
    }
    const context = {
      app,
      path: envelope.path,
      event: envelope.event,
      method: envelope.method,
      id: envelope.id,
      params,
      result: envelope.data,
      dispatch: envelope.data,
    } as unknown as HookContext;
    const resolved = await resolveLocalDelivery(envelope.data, context);
    if (resolved.tenantId !== envelope.tenantId) return;
    const combined = combinePublishChannels(resolved.delivery);
    if (process.env.AGOR_DEBUG_REALTIME_PUBLISH === '1') {
      console.debug(
        `[realtime/redis] relay authorized path=${envelope.path} event=${envelope.event} tenant=${envelope.tenantId} connections=${combined.connections.length}`
      );
    }
    if (combined.connections.length === 0) return;
    // This enters Feathers' transport dispatcher directly and deliberately
    // does not re-enter app.publish, preventing a Redis relay loop.
    (app as unknown as { emit: (...args: unknown[]) => boolean }).emit(
      'publish',
      envelope.event,
      combined,
      context,
      envelope.data
    );
  });
}

function combinePublishChannels(delivery: PublishChannel | PublishChannel[]) {
  const channels = Array.isArray(delivery) ? delivery : [delivery];
  const connections = [...new Set(channels.flatMap((channel) => channel.connections as unknown[]))];
  return {
    connections,
    get length() {
      return connections.length;
    },
    dataFor(connection: unknown) {
      const channel = channels.find((candidate) =>
        (candidate.connections as unknown[]).includes(connection)
      ) as (PublishChannel & { data?: unknown; dataFor?: (value: unknown) => unknown }) | undefined;
      return channel?.dataFor ? channel.dataFor(connection) : channel?.data;
    },
  };
}
