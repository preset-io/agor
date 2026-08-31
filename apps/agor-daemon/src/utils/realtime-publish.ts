import {
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import type {
  BoardRepository,
  BranchRepository,
  SessionRepository,
  TenantScopeAwareDatabase,
} from '@agor/core/db';
import { getCurrentTenantId, runWithTenantDatabaseScope, shortId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  isBoardRemovalRealtimeVisibilitySnapshot,
  isBranchRemovalRealtimeVisibilitySnapshot,
  isRealtimeRelayEnvelope,
  MAX_REALTIME_RELAY_BYTES,
  REALTIME_RELAY_VERSION,
  type RealtimeRelayEnvelope,
} from '@agor/core/realtime';
import {
  BOARD_COMMENT_ATTACHMENT_POLICY,
  type BoardID,
  type BoardRemovalRealtimeVisibilitySnapshot,
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
import {
  executorTaskRoomName,
  isExecutorTaskRoomName,
  sessionStreamRoomName,
  tenantChannelName,
} from '../realtime/routing.js';
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
import {
  isRealtimePublishAllowed,
  type RealtimePublishAudience,
  realtimePublishPolicyFor,
} from './realtime-publish-policy.js';

export const BRANCH_REMOVAL_VISIBILITY_PARAM = '_agorRealtimeBranchRemovalVisibility';
export const BOARD_REMOVAL_VISIBILITY_PARAM = '_agorRealtimeBoardRemovalVisibility';

export function setBoardRemovalRealtimeVisibility(
  params: HookContext['params'],
  boardId: BoardID,
  visibility:
    | { mode: typeof BranchRealtimeVisibilityMode.ALL_AUTHENTICATED }
    | { mode: typeof BranchRealtimeVisibilityMode.EXPLICIT_USERS; userIds: ReadonlySet<UserID> }
): void {
  const snapshot: BoardRemovalRealtimeVisibilitySnapshot =
    visibility.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED
      ? { boardId, mode: BranchRealtimeVisibilityMode.ALL_AUTHENTICATED }
      : {
          boardId,
          mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS,
          userIds: [...visibility.userIds].sort(),
        };
  (params as HookContext['params'] & Record<string, unknown>)[BOARD_REMOVAL_VISIBILITY_PARAM] =
    snapshot;
}

function boardRemovalVisibilitySnapshot(
  context: PublishContext,
  boardId: string
): BoardRemovalRealtimeVisibilitySnapshot | null {
  if (context.path !== 'boards' || context.event !== 'removed') return null;
  const value = (context.params as Record<string, unknown> | undefined)?.[
    BOARD_REMOVAL_VISIBILITY_PARAM
  ];
  return isBoardRemovalRealtimeVisibilitySnapshot(value) && value.boardId === boardId
    ? value
    : null;
}

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
 * Private control-plane room for the one executor JWT scoped to a Task.
 *
 * Unlike normal Task events, membership is not derived from branch visibility:
 * configureChannels joins this room only after RuntimeJWTStrategy has verified
 * an `executor-session` token whose signed `task_id` matches the room. There is
 * no client-callable subscribe method.
 */
export function executorTaskChannelName(tenantId: string, taskId: string): string {
  return executorTaskRoomName(tenantId, taskId);
}

export function sessionStreamChannelName(tenantId: string, sessionId: string): string {
  return sessionStreamRoomName(tenantId, sessionId);
}

/** Drop task-control capability before disconnecting an executor socket. */
export function leaveAllExecutorTaskChannels(app: Application, connection: unknown): void {
  for (const name of app.channels ?? []) {
    if (isExecutorTaskRoomName(name)) {
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
  tenantId: string,
  sessionId: string,
  connection: unknown
): void {
  app.channel(sessionStreamChannelName(tenantId, sessionId)).join(connection as never);
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
  tenantId: string,
  sessionId: string,
  connection: unknown
): void {
  existingChannel(app, sessionStreamChannelName(tenantId, sessionId))?.leave(connection as never);
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

/**
 * Structural seam kept beside the realtime path while the daemon typecheck can
 * consume an older watched @agor/core declaration snapshot.
 */
export type RealtimeAccessBoardRepository = Pick<BoardRepository, 'findById'> & {
  findRealtimeViewUserIds(boardId: BoardID): Promise<import('@agor/core/types').UUID[]>;
};

type RealtimePublishOptions = {
  app: Application;
  db?: TenantScopeAwareDatabase;
  branchRbacEnabled: boolean;
  branchRepository: BranchRepository;
  boardRepository?: RealtimeAccessBoardRepository;
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
  | { kind: 'board'; boardId: string | null }
  | { kind: 'branch'; branchId: BranchID | null }
  | { kind: 'branches'; branchIds: BranchID[] }
  | { kind: 'users'; userIds: Set<string> }
  | { kind: 'serviceOnly' };

/**
 * The declared audience for a path, or `undefined` when it was never declared.
 * `undefined` is a DENY here, not a default — see `realtime-publish-policy.ts`.
 * Every scoping decision below reads from that one table so the audiences a
 * reviewer sees listed are the audiences the publisher actually applies.
 */
function audienceFor(path: string | null | undefined): RealtimePublishAudience | undefined {
  return realtimePublishPolicyFor(path)?.audience;
}

/**
 * Apply a service's read-role floor to realtime delivery.
 *
 * Channel membership proves authentication/tenant admission, not permission
 * to read every service in that channel. Keeping this in the global publisher
 * makes local and Redis-relayed events obey the same floor and prevents a raw
 * Feathers listener from bypassing the service hook.
 */
function applyRealtimeRoleFloor(
  channel: PublishChannel,
  path: string | null | undefined
): PublishChannel {
  const minimumRole = realtimePublishPolicyFor(path)?.minimumRole;
  if (!minimumRole) return channel;
  return channel.filter((connection: unknown) => {
    if (isServiceConnection(connection)) return true;
    return hasMinimumRole(userFromConnection(connection)?.role, minimumRole);
  });
}

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
  'executor-git-environment',
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
  'claude-auth/oauth',
  'claude-auth/logout',
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
    audienceFor(context.path) === 'branch-route' &&
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

function extractBoardId(data: unknown, context: PublishContext): string | undefined {
  const record = asRecord(data);
  return (
    pickString(record, 'board_id', 'boardId') ??
    (context.path === 'boards' && typeof context.id === 'string' ? context.id : undefined)
  );
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

/**
 * Resolve every attachment on a board resource. `undefined` means the row is
 * purely spatial and should inherit board visibility; `null` means at least
 * one caller-supplied attachment could not be resolved and must fail closed.
 */
async function resolveBranchIdsFromBoardResource(
  data: unknown,
  context: PublishContext,
  accessCache: RealtimeAccessCache
): Promise<BranchID[] | null | undefined> {
  const record = asRecord(data);
  if (!record) return null;

  const branchIds = new Set<BranchID>();
  let hasAttachment = false;
  for (const { field, resource } of BOARD_COMMENT_ATTACHMENT_POLICY) {
    const attachmentId = pickString(record, field);
    let branchId: BranchID | null | undefined;
    switch (resource) {
      case 'branch': {
        const directBranchId = attachmentId ?? extractBranchId(data, context);
        if (directBranchId) branchId = directBranchId as BranchID;
        break;
      }
      case 'session': {
        if (attachmentId) branchId = await sessionBranchId(attachmentId, accessCache);
        break;
      }
      case 'task': {
        if (attachmentId) {
          const resolvedSessionId = await taskSessionId(context, attachmentId);
          branchId = resolvedSessionId
            ? await sessionBranchId(resolvedSessionId, accessCache)
            : null;
        }
        break;
      }
      case 'message': {
        if (attachmentId) {
          const resolvedSessionId = await messageSessionId(context, attachmentId);
          branchId = resolvedSessionId
            ? await sessionBranchId(resolvedSessionId, accessCache)
            : null;
        }
        break;
      }
    }
    if (branchId === undefined) continue;
    hasAttachment = true;
    if (!branchId) return null;
    branchIds.add(branchId);
  }

  return hasAttachment ? [...branchIds] : undefined;
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
  const audience = audienceFor(context.path);
  switch (audience) {
    case 'board': {
      return { kind: 'board', boardId: extractBoardId(data, context) ?? null };
    }
    case 'board-resource': {
      const branchIds = await resolveBranchIdsFromBoardResource(data, context, accessCache);
      if (branchIds === null) return { kind: 'serviceOnly' };
      if (branchIds === undefined) {
        return { kind: 'board', boardId: extractBoardId(data, context) ?? null };
      }
      return { kind: 'branches', branchIds };
    }
    case 'branch':
    case 'branch-route': {
      const branchId = extractBranchId(data, context);
      return { kind: 'branch', branchId: (branchId as BranchID | undefined) ?? null };
    }

    case 'branch-or-session': {
      // Hot session/message/task paths must carry branch_id or session_id —
      // custom `sessions` events carry camelCase `sessionId` rather than the
      // row's `branch_id`. Avoid message/task fallback lookups here so
      // malformed streaming events fail closed instead of doing DB work per
      // chunk.
      const branchId = await resolveBranchIdFromBranchOrSession(data, context, accessCache);
      return { kind: 'branch', branchId: branchId ?? null };
    }

    case 'branch-optional': {
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

    case 'artifact': {
      const branchId = extractBranchId(data, context);
      if (branchId) return { kind: 'branch', branchId: branchId as BranchID };

      // Null-branch artifacts are not covered by branch visibility. Keep
      // delivery narrow to the creator/admins when the creator is known,
      // otherwise service connections only.
      const createdBy = extractCreatedBy(data);
      return createdBy ? { kind: 'users', userIds: new Set([createdBy]) } : { kind: 'serviceOnly' };
    }

    case 'tenant':
    // 'knowledge' should not reach here — resolveKnowledgeRealtimeUserIds
    // answers for every `kb/*` path earlier in resolveDelivery. It is listed
    // explicitly anyway: if that call ever stops covering a kb path, the
    // tenant channel is the same answer it had before, not a silent widening
    // through a catch-all.
    case 'knowledge':
      return { kind: 'global' };

    case 'none':
    case undefined:
      // Unreachable: the gate in resolveLocalDelivery denied both before this
      // ran. Answering serviceOnly rather than falling through keeps the two
      // in agreement if the gate is ever moved.
      return { kind: 'serviceOnly' };

    default:
      return unhandledAudienceScope(audience, context);
  }
}

/**
 * Fail closed on an audience nobody wrote a case for.
 *
 * The `never` parameter is the real mechanism: adding a member to
 * `RealtimePublishAudience` without a case above stops compiling, so
 * `turbo run typecheck` catches it before anyone can ship it. This body is the
 * belt to that braces — if the type is ever widened through a cast, delivery
 * narrows to service connections instead of quietly reaching the whole tenant,
 * which is the failure this whole file exists to prevent.
 */
function unhandledAudienceScope(audience: never, context: PublishContext): PublishScope {
  console.warn('[realtime] Suppressing event with an unhandled publish audience', {
    audience,
    path: context.path,
    event: context.event,
  });
  return { kind: 'serviceOnly' };
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
  tenantId: string,
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
  const existingRoom = existingChannel(app, sessionStreamChannelName(tenantId, sessionId));
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
    const isMissingTenant =
      error instanceof TenantResolutionError && error.message.startsWith('Missing tenant context');
    const connectionTenantId = extractConnectionTenantId(context);
    if (isMissingTenant && connectionTenantId) return connectionTenantId;

    const ambientTenantId = getCurrentTenantId();
    if (isMissingTenant && ambientTenantId) {
      return ambientTenantId as TenantID;
    }
    throw error;
  }
}

/**
 * Register the single global Feathers publish handler.
 *
 * Nothing publishes unless `realtime-publish-policy.ts` says who may hear it.
 * That gate runs first and is independent of branch RBAC: an undeclared path
 * reaches nobody at all, service connections included, and never enters the
 * Redis relay.
 *
 * For a path that IS declared, the audience is then narrowed as before. In
 * open-access mode a declared service reaches every authenticated socket in the
 * tenant. When branch RBAC is enabled, events for branch/session-scoped
 * resources are reduced to authenticated connections whose user currently has
 * at least `view` permission for the event's branch. Service executor sockets
 * remain trusted so prompt/permission plumbing keeps working.
 */
export function configureRealtimePublish(options: RealtimePublishOptions): void {
  const {
    app,
    db,
    branchRbacEnabled,
    branchRepository,
    boardRepository,
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
    // Default-deny. Feathers routes EVERY service event that has no publisher
    // of its own through this handler, so an undeclared path is one nobody
    // decided about — including the RPC routes that emit their own response
    // body as `created`. Suppressing here also keeps the event off the Redis
    // relay below, because `tenantId` stays undefined.
    if (!isRealtimePublishAllowed(context.path)) {
      return { delivery: [] as PublishChannel[], tenantId: undefined };
    }

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
          // Service connections are tenant-owned too. A missing tenant must
          // not degrade into the old cross-tenant "service-only" broadcast.
          return { delivery: [] as PublishChannel[], tenantId: undefined };
        }
        throw error;
      }
    }

    // Authentication/tenant channels are deliberately broad. Narrow them to
    // the declared service read floor before ANY audience resolution so the
    // global, branch, knowledge, streaming, and Redis-relay paths cannot
    // accidentally widen the result again.
    tenantScoped = applyRealtimeRoleFloor(tenantScoped, context.path);

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
          tenantId ?? 'standalone',
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

      if (context.path === 'artifacts' && context.event === 'agor-query') {
        const requestedBy = pickString(asRecord(data), 'requested_by_user_id');
        if (!requestedBy) return [];
        return tenantScoped.filter(
          (connection: unknown) => userFromConnection(connection)?.user_id === requestedBy
        );
      }

      if (!branchRbacEnabled) return tenantScoped;

      const scope = await resolvePublishScope(data, context, accessCache);
      if (scope.kind === 'global') return tenantScoped;
      if (scope.kind === 'serviceOnly') return filterToServiceConnections(tenantScoped);
      if (scope.kind === 'users') {
        return filterToUserIdsOrAdmins(tenantScoped, scope.userIds, allowSuperadmin);
      }
      if (scope.kind === 'board') {
        if (!scope.boardId || !boardRepository) {
          return filterToServiceConnections(tenantScoped);
        }
        const removalVisibility = boardRemovalVisibilitySnapshot(context, scope.boardId);
        if (removalVisibility?.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED) {
          return tenantScoped;
        }
        if (removalVisibility?.mode === BranchRealtimeVisibilityMode.EXPLICIT_USERS) {
          return filterToUserIdsOrAdmins(
            tenantScoped,
            new Set(removalVisibility.userIds),
            allowSuperadmin
          );
        }
        // Resolve the current board row before using its visibility. Event
        // payloads also cross the Redis relay and can be stale or forged, so
        // fields such as `access_mode` are data to publish, never authority.
        // A hard delete is the sole exception and was handled above using the
        // server-captured pre-delete visibility snapshot.
        let loadedBoard: Awaited<ReturnType<BoardRepository['findById']>>;
        try {
          loadedBoard = await boardRepository.findById(scope.boardId);
        } catch {
          return filterToServiceConnections(tenantScoped);
        }
        if (!loadedBoard) return filterToServiceConnections(tenantScoped);
        const currentBoard = loadedBoard;

        // Materialize the exact normalized audience in one query. A branch,
        // payload field, or legacy access_mode is never board authority, and a
        // direct deny must still suppress permissive Others for one user.
        let visibleUserIds: Set<string>;
        try {
          visibleUserIds = new Set(
            await boardRepository.findRealtimeViewUserIds(currentBoard.board_id)
          );
        } catch {
          // Concurrent policy/deletion failure fails narrow. Deleted boards
          // require and use the pre-delete snapshot handled above.
          return filterToServiceConnections(tenantScoped);
        }
        return filterToUserIdsOrAdmins(tenantScoped, visibleUserIds, allowSuperadmin);
      }
      if (scope.kind === 'branches') {
        let explicitUserIds: Set<UserID> | null = null;
        for (const branchId of scope.branchIds) {
          const visibility = await accessCache.getBranchVisibility(branchId);
          if (!visibility) return filterToServiceConnections(tenantScoped);
          if (visibility.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED) continue;
          if (explicitUserIds) {
            const intersection = new Set<UserID>();
            for (const userId of explicitUserIds) {
              if (visibility.userIds.has(userId)) intersection.add(userId);
            }
            explicitUserIds = intersection;
          } else {
            explicitUserIds = new Set(visibility.userIds);
          }
        }
        return explicitUserIds
          ? filterToUserIdsOrSuperadmins(tenantScoped, explicitUserIds, allowSuperadmin)
          : tenantScoped;
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
        const removedBoardId = extractBoardId(relayData, context);
        const boardRemovalVisibility = removedBoardId
          ? boardRemovalVisibilitySnapshot(context, removedBoardId)
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
          ...(boardRemovalVisibility ? { boardRemovalVisibility } : {}),
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
    if (envelope.boardRemovalVisibility) {
      params[BOARD_REMOVAL_VISIBILITY_PARAM] = envelope.boardRemovalVisibility;
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
