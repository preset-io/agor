import type {
  BoardID,
  CursorMovedEvent,
  MCPOAuthAttemptID,
  MCPServerID,
  PresenceUpdatedEvent,
  RepoCloneError,
} from '@agor/core/types';

/**
 * Socket.IO room components are opaque identifiers, not path fragments.
 *
 * Tenant ids can come from an external identity provider and are not restricted
 * to UUID syntax. Concatenating them with `:` or `/` makes different tuples
 * collide (for example a tenant id containing `:user:` can collide with
 * another tenant's per-user room). Base64url is injective for UTF-8 byte
 * strings and contains none of our room separators.
 */
export function encodeRealtimeRoomComponent(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeRealtimeRoomComponent(value: string): string | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return decoded && encodeRealtimeRoomComponent(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * One authoritative, versioned naming scheme for Socket.IO rooms and Feathers
 * channels. The version prevents a mixed deployment from accidentally treating
 * an old unescaped name as a new structured room.
 */
const REALTIME_ROOM_PREFIX = 'agor:v2:tenant:';

/** Internal server-to-server eviction signal; never emitted to browser rooms. */
export const HA_AUTHORIZATION_INVALIDATION_EVENT = 'agor:authorization-invalidated:v1';

/**
 * Distributed authorization-cache invalidation.
 *
 * Additive mutations (for example granting an owner or creating a new
 * resource) only need to clear replica-local authorization caches. Mutations
 * that can revoke existing access additionally disconnect authenticated
 * sockets so every passive room capability is rebuilt from current authority.
 *
 * `disconnectSockets` is optional for rolling-deployment compatibility: an
 * older sender produces an eviction, and a receiver must default to the safer
 * disconnecting behavior when the field is absent.
 */
export interface RealtimeAuthorizationInvalidation {
  tenantId?: unknown;
  disconnectSockets?: boolean;
}

/** Internal exact/session executor capability revocation signal. */
export const HA_EXECUTOR_TOKEN_INVALIDATION_EVENT = 'agor:executor-token-invalidated:v1';

/** Process-local notification emitted before stale sockets are disconnected. */
export const LOCAL_AUTHORIZATION_INVALIDATION_EVENT = 'realtime:authorization-invalidated-local';

/** Process-local cache-only fence for additive authorization changes. */
export const LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT =
  'realtime:authorization-cache-invalidated-local';

export function tenantChannelName(tenantId: string): string {
  return `${REALTIME_ROOM_PREFIX}${encodeRealtimeRoomComponent(tenantId)}`;
}

export function tenantUserChannelName(tenantId: string, userId: string): string {
  return `${tenantChannelName(tenantId)}:user:${encodeRealtimeRoomComponent(userId)}`;
}

export function boardPresenceRoomName(tenantId: string, boardId: string): string {
  return `${tenantChannelName(tenantId)}:board:${encodeRealtimeRoomComponent(boardId)}:presence`;
}

export function sessionStreamRoomName(tenantId: string, sessionId: string): string {
  return `${tenantChannelName(tenantId)}:session-stream:${encodeRealtimeRoomComponent(sessionId)}`;
}

export function executorTaskRoomName(tenantId: string, taskId: string): string {
  return `${tenantChannelName(tenantId)}:executor-task:${encodeRealtimeRoomComponent(taskId)}`;
}

export function terminalChannelName(tenantId: string, userId: string, terminalId: string): string {
  return `agor/v2/tenant/${encodeRealtimeRoomComponent(tenantId)}/user/${encodeRealtimeRoomComponent(userId)}/terminal/${encodeRealtimeRoomComponent(terminalId)}`;
}

export function parseTerminalChannel(
  channel: string
): { tenantId: string; userId: string; terminalId: string } | null {
  if (typeof channel !== 'string') return null;
  const parts = channel.split('/');
  if (
    parts.length !== 8 ||
    parts[0] !== 'agor' ||
    parts[1] !== 'v2' ||
    parts[2] !== 'tenant' ||
    parts[4] !== 'user' ||
    parts[6] !== 'terminal'
  ) {
    return null;
  }
  const tenantId = decodeRealtimeRoomComponent(parts[3]);
  const userId = decodeRealtimeRoomComponent(parts[5]);
  const terminalId = decodeRealtimeRoomComponent(parts[7]);
  return tenantId && userId && terminalId ? { tenantId, userId, terminalId } : null;
}

export function isTenantRealtimeRoomName(name: string): boolean {
  return name.startsWith(REALTIME_ROOM_PREFIX);
}

export function isSessionStreamRoomName(name: string): boolean {
  return name.startsWith(REALTIME_ROOM_PREFIX) && name.includes(':session-stream:');
}

export function isExecutorTaskRoomName(name: string): boolean {
  return name.startsWith(REALTIME_ROOM_PREFIX) && name.includes(':executor-task:');
}

interface HaNativeSocketPayloads {
  'cursor-moved': CursorMovedEvent;
  'cursor-left': { userId: string; boardId: BoardID; timestamp: number };
  'presence-updated': PresenceUpdatedEvent;
  'repo:cloneError': {
    slug: string;
    url: string;
    error: string;
    repo_id: string;
    clone_error?: RepoCloneError;
  };
  'oauth:completed': {
    attempt_id: MCPOAuthAttemptID;
    success: boolean;
    mcp_server_id?: string;
    oauth_mode: 'per_user' | 'shared';
  };
  'oauth:disconnected': { mcp_server_id: MCPServerID };
}

/** Native Socket.IO packets intentionally permitted to cross the HA Redis adapter. */
export const HA_NATIVE_SOCKET_EVENT_INVENTORY = [
  'cursor-moved',
  'cursor-left',
  'presence-updated',
  'repo:cloneError',
  'oauth:completed',
  'oauth:disconnected',
] as const satisfies readonly (keyof HaNativeSocketPayloads)[];

type NativeSocketTarget = {
  emit(event: string, payload: unknown): unknown;
};

/**
 * Audited boundary for native cross-replica packets. Other room-targeted
 * Socket.IO emissions must opt into `.local` so a missed feature gate cannot
 * silently put a new payload onto Redis.
 */
export function emitHaNativeSocketEvent<Event extends keyof HaNativeSocketPayloads>(
  target: NativeSocketTarget,
  event: Event,
  payload: HaNativeSocketPayloads[Event]
): void {
  target.emit(event, payload);
}
