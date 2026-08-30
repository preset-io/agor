/**
 * Socket.io Configuration
 *
 * Configures WebSocket server with authentication middleware,
 * cursor presence tracking, and connection management.
 *
 * SECURITY (terminal:* events):
 * Browser-emitted terminal events (terminal:input, terminal:resize, join)
 * are gated by per-event authentication checks. Without these checks any
 * insufficiently scoped socket that knew a target user_id could inject keystrokes into
 * that user's web terminal channel. In simple mode this is a shell as the
 * daemon user (with read access to ~/.agor/config.yaml,
 * agor.db, and the JWT secret). See `terminal:*` handlers below.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS,
  type ResolvedMultiTenancyConfig,
  SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
} from '@agor/core/config';
import { shortId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  type Board,
  type BoardID,
  type BoardPresenceSubscriptionRequest,
  type CursorLeaveEvent,
  type CursorLeftEvent,
  type CursorMovedEvent,
  type CursorMoveEvent,
  MAX_PRESENCE_BOARD_SUBSCRIPTIONS,
  MAX_TENANT_ID_LENGTH,
  PRESENCE_SOCKET_EVENTS,
  type PresenceHeartbeatEvent,
  type PresenceLeftEvent,
  type PresenceSubscriptionAcknowledgement,
  type PresenceUpdatedEvent,
  type TenantContext,
  type TerminalAllocatedEvent,
} from '@agor/core/types';
import type { Server, ServerOptions, Socket } from 'socket.io';
import {
  getAuthenticatedConnectionAuthority,
  isAuthenticatedConnectionAuthorityCurrent,
  retireAuthenticatedConnectionAuthority,
} from '../auth/authenticated-connection-authority.js';
import { getOrCreateExecutorConnectionRevocationFence } from '../auth/executor-connection-admission.js';
import type { ExecutorSessionTokenRevocation } from '../auth/executor-session-token.js';
import {
  boardPresenceAssociationRoomName,
  boardPresenceRoomName,
  emitHaNativeSocketEvent,
  HA_AUTHORIZATION_INVALIDATION_EVENT,
  HA_EXECUTOR_TOKEN_INVALIDATION_EVENT,
  LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT,
  LOCAL_AUTHORIZATION_INVALIDATION_EVENT,
  parseTerminalChannel,
  type RealtimeAuthorizationInvalidation,
  tenantChannelName,
  tenantUserChannelName,
  terminalChannelName,
} from '../realtime/routing.js';
import type { TerminalAttachmentIdentity } from '../services/terminals.js';
import {
  TERMINAL_REQUEST_JOIN_CHANNEL,
  type TerminalRequestConnection,
} from '../terminal-socket-connection.js';
import { FEATHERS_INSTRUMENTATION_REASON } from '../utils/feathers-instrumentation.js';
import {
  joinExecutorTaskChannel,
  leaveAllExecutorTaskChannels,
} from '../utils/realtime-publish.js';
import {
  AGOR_SOCKET_AUTHORITY_DISCONNECTED_EVENT,
  installSocketAuthorityId,
} from '../utils/socket-request-authority.js';
import type { BuildInfo } from './build-info.js';
import type { CorsOrigin } from './cors.js';

/**
 * FeathersJS extends Socket.io socket with authentication context.
 *
 * Tenant context and the server-owned connection authority are populated by
 * the authenticated Socket.IO handshake before the connection event is
 * accepted. Native handlers read only the immutable authority; Feathers
 * identity fields are a frozen server-owned projection for service hooks.
 *
 * Live authentication replacement is intentionally unsupported. Routine token
 * refresh changes only the next-handshake credential; identity changes require
 * a fresh Socket.IO namespace connection.
 */
interface FeathersSocket extends Socket {
  feathers?: object;
  data: {
    currentBoardId?: BoardID;
    /** Boards authorized through the Feathers boards.get hook on this socket. */
    authorizedBoardIds?: Set<string>;
    /** In-flight cursor grants count against the same hard room bound. */
    pendingCursorBoardAdmissions?: Map<string, symbol>;
    /** Low-frequency association rooms authorized through boards.find. */
    presenceAssociationBoardIds?: Set<string>;
    /** A board association is publishable only after this full-set grant exists. */
    hasPresenceAssociationSubscription?: boolean;
    /** Monotonic generation plus a single latest-wins pending authorization request. */
    presenceSubscriptionGeneration?: number;
    pendingPresenceSubscription?: PendingPresenceSubscription;
    presenceSubscriptionRunning?: boolean;
    /** Random per-connection identity; never caller controlled. */
    presenceId?: string;
    presenceActive?: boolean;
    presenceBoardId?: BoardID;
    lastTenantPresenceEmitAt?: number;
    lastBoardPresenceEmitAt?: number;
  };
  handshake: Socket['handshake'] & { headers?: Record<string, string | string[] | undefined> };
}

type PresenceSubscriptionAck = (result: PresenceSubscriptionAcknowledgement) => void;

interface PendingPresenceSubscription {
  generation: number;
  boardIds: string[];
  acknowledge?: PresenceSubscriptionAck;
}

/** Remove realtime capability before clearing the authentication projection. */
function retireSocketConnectionAuthority(app: Application, connection: unknown): void {
  leaveAllExecutorTaskChannels(app, connection);
  retireAuthenticatedConnectionAuthority(connection);
}

export interface SocketIOOptions {
  /** CORS origin configuration */
  corsOrigin: CorsOrigin;
  /**
   * Whether the HTTP CORS layer is allowing credentials. The socket.io
   * transport must mirror this — when the HTTP side has dropped credentials
   * (wildcard mode), letting socket.io still claim `credentials: true`
   * creates spec-noncompliant credentialed cross-origin behavior.
   */
  credentialsAllowed: boolean;
  /**
   * Whether the web terminal feature is enabled (mirrors
   * `execution.allow_web_terminal`). When false, ALL `terminal:*` events
   * (and joins to versioned tenant/user/terminal rooms) are rejected at the socket
   * layer. This matches the HTTP terminals service gate in register-hooks.ts
   * and keeps the kill-switch effective for both transports. Defaults to
   * true if omitted. Terminal room names are opaque, versioned, and
   * tenant/user/terminal-qualified by realtime/routing.ts.
   */
  webTerminalEnabled?: boolean;
  /**
   * Daemon build identity emitted as the `server-info` welcome event on every
   * (re)connection. UI tabs capture the first value and compare each
   * subsequent one — a mismatch flips ConnectionStatus into the amber
   * "out of sync" state. /health carries the same field as a poll fallback.
   * Optional so unit tests don't have to plumb it; the welcome event is
   * simply skipped when omitted.
   */
  buildInfo?: BuildInfo;
  /**
   * Process identity is not authority by itself. Terminal capabilities use
   * bootId only as a process-incarnation discriminator, alongside the
   * authoritative process-local attachment registry.
   */
  workIdentity?: { instanceId: string; bootId: string };
  /** Enables fail-closed tenant scoping for distributed invalidation messages. */
  multiTenancy?: ResolvedMultiTenancyConfig;
  /** Redis adapter constructor in explicit HA mode. */
  adapter?: ServerOptions['adapter'];
  /** Called as soon as Feathers creates the Socket.IO server. */
  onServerCreated?: (io: Server) => void;
}

/**
 * Auth state derived from a socket. Returned by {@link getSocketAuthState}.
 *
 * - `userId` is the authenticated interactive user's id. Delegated executor
 *   connections deliberately remain a separate native-socket principal even
 *   though Feathers service calls project their initiating user.
 * - `isService` is true only for explicit daemon service identities and the
 *   separately restricted terminal-executor identity.
 *
 * `isAuthenticated` is intentionally not a field: user, service, and executor
 * principals are already represented independently, and a fourth mutable flag
 * would only create drift.
 */
export interface SocketAuthState {
  userId: string | null;
  isService: boolean;
  /** Delegated-user executor credential at the native Socket.IO boundary. */
  isExecutor?: boolean;
  tenant?: TenantContext;
  /**
   * For terminal executor service sockets: the single user this executor is
   * allowed to act for (bound into its token as `terminal_user_id` at spawn
   * time). Undefined for generic (non-terminal) service tokens and for user
   * sockets. Terminal handlers require the payload's userId to match this.
   */
  terminalUserId?: string;
  terminalId?: string;
  terminalBranchId?: string;
  terminalOwnerBootId?: string;
}

function socketAuthState(
  userId: string | null,
  isService: boolean,
  isExecutor: boolean,
  tenant?: TenantContext,
  terminalUserId?: string,
  terminalId?: string,
  terminalBranchId?: string,
  terminalOwnerBootId?: string
): SocketAuthState {
  const state: SocketAuthState = { userId, isService };
  if (isExecutor) state.isExecutor = true;
  if (tenant) state.tenant = tenant;
  if (terminalUserId) state.terminalUserId = terminalUserId;
  if (terminalId) state.terminalId = terminalId;
  if (terminalBranchId) state.terminalBranchId = terminalBranchId;
  if (terminalOwnerBootId) state.terminalOwnerBootId = terminalOwnerBootId;
  return state;
}

/**
 * Extract the authenticated identity from a socket.
 *
 * The server-owned connection authority is the only identity source. Feathers
 * entity fields and Socket.IO data are projections for their respective
 * frameworks, never competing authentication signals.
 *
 * Exported for unit tests and for handler authorization checks.
 */
export function getSocketAuthState(socket: Socket): SocketAuthState {
  const s = socket as FeathersSocket;
  const authority = getAuthenticatedConnectionAuthority(s.feathers);
  if (!authority) return socketAuthState(null, false, false);
  const tenant = authority.tenant;
  if (authority.principal.kind === 'executor') {
    return socketAuthState(null, false, true, tenant);
  }
  if (authority.principal.kind === 'terminal-executor') {
    return socketAuthState(
      null,
      true,
      false,
      tenant,
      authority.principal.terminalUserId,
      authority.principal.terminalId,
      authority.principal.branchId,
      authority.principal.ownerBootId
    );
  }
  if (authority.principal.kind === 'service') {
    return socketAuthState(null, true, false, tenant);
  }
  return socketAuthState(authority.principal.userId, false, false, tenant);
}

/**
 * Convenience predicate — prefer this over duplicating the
 * `userId || isService` pattern at call sites.
 */
function isAuthenticated(auth: SocketAuthState): boolean {
  return auth.userId !== null || auth.isService || auth.isExecutor === true;
}

/**
 * Token-bucket rate limiter for per-socket terminal:input flooding.
 *
 * Generous defaults (500 events/sec, burst 1000) — even fast typists +
 * paste-bomb rarely exceed this. The cap exists to prevent a hijacked
 * (or buggy) client from saturating the executor's PTY input loop or
 * filling logs. Returns a function: call() → boolean (true = allowed).
 *
 * Exported for unit tests.
 */
export function createTokenBucket(
  capacity: number,
  refillPerSec: number,
  now: () => number = Date.now
): () => boolean {
  let tokens = capacity;
  let last = now();
  return () => {
    const t = now();
    const elapsed = (t - last) / 1000;
    last = t;
    tokens = Math.min(capacity, tokens + elapsed * refillPerSec);
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  };
}

// Compatibility export for existing tests/callers; routing.ts owns the format.
export { parseTerminalChannel };

export interface SocketIOResult {
  /** Socket.io server instance (for graceful shutdown) */
  socketServer: Server | null;
}

/**
 * Global presence consumers (e.g. navbar facepile) don't need every cursor
 * sample. Emit a lightweight presence heartbeat at most this often while a
 * user stays on the same board.
 */
const GLOBAL_PRESENCE_EMIT_INTERVAL_MS = 10_000;
const MAX_REALTIME_BOARD_ID_LENGTH = 256;
const MAX_CURSOR_COORDINATE_MAGNITUDE = 10_000_000;
const CURSOR_MOVE_RATE_LIMIT = { capacity: 30, refillPerSec: 15 } as const;
const CURSOR_WATCH_RATE_LIMIT = { capacity: 20, refillPerSec: 5 } as const;
const PRESENCE_HEARTBEAT_RATE_LIMIT = { capacity: 10, refillPerSec: 2 } as const;
const PRESENCE_SUBSCRIPTION_RATE_LIMIT = { capacity: 5, refillPerSec: 1 } as const;

function isBoundedBoardId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_REALTIME_BOARD_ID_LENGTH
  );
}

function isCursorMoveEvent(value: unknown): value is CursorMoveEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<CursorMoveEvent>;
  return (
    isBoundedBoardId(event.boardId) &&
    typeof event.x === 'number' &&
    Number.isFinite(event.x) &&
    Math.abs(event.x) <= MAX_CURSOR_COORDINATE_MAGNITUDE &&
    typeof event.y === 'number' &&
    Number.isFinite(event.y) &&
    Math.abs(event.y) <= MAX_CURSOR_COORDINATE_MAGNITUDE
  );
}

function boardsFromServiceResult(value: unknown): Board[] {
  if (Array.isArray(value)) return value as Board[];
  const data = (value as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? (data as Board[]) : [];
}

function normalizeAcknowledgement<Result>(value: unknown): ((result: Result) => void) | undefined {
  return typeof value === 'function' ? (value as (result: Result) => void) : undefined;
}

function deferExecutorTransportWork(work: () => void): void {
  // Transport-only callback: it must never perform database or tenant-owned
  // work while retaining the revoking request's async context.
  setImmediate(work);
}

/**
 * Retire a revoked executor transport without overtaking the RPC response that
 * caused the revocation.
 *
 * Task terminality revokes the bearer inside the Feathers service call. Its
 * Socket.IO acknowledgement is queued only after that call returns, so an
 * unconditional next-turn disconnect can close a backpressured transport
 * before the already-committed terminal result reaches the executor. Wait for
 * the current transport write to become writable again; authority and Task
 * room membership have already been removed synchronously, so this bounded
 * drain window grants no residual service or realtime access.
 */
interface ExecutorRpcAcknowledgement {
  socket: Socket;
  revoked: boolean;
  acknowledgeRetirement?: () => void;
}

const executorRpcAcknowledgement = new AsyncLocalStorage<ExecutorRpcAcknowledgement>();

function disconnectRevokedExecutorAfterTransportDrain(
  socket: Socket,
  waitForAcknowledgement: boolean
): () => void {
  // The lightweight Socket.IO unit harness has no Engine.IO transport. Keep
  // its behavior representative without requiring transport internals there.
  const connection = socket.conn;
  if (!connection) {
    deferExecutorTransportWork(() => socket.disconnect(true));
    return () => undefined;
  }

  let finished = false;
  let pendingTransport: Socket['conn']['transport'] | undefined;
  let onReady: (() => void) | undefined;
  let onSocketDisconnect: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (pendingTransport && onReady) pendingTransport.removeListener('ready', onReady);
    if (onSocketDisconnect) socket.removeListener('disconnect', onSocketDisconnect);
    if (deadline) clearTimeout(deadline);
    pendingTransport = undefined;
    onReady = undefined;
    onSocketDisconnect = undefined;
    deadline = undefined;
  };
  onSocketDisconnect = () => {
    if (finished) return;
    finished = true;
    cleanup();
  };
  const disconnect = () => {
    if (finished) return;
    finished = true;
    cleanup();
    if (socket.connected) socket.disconnect(true);
  };
  const inspectTransport = () => {
    if (finished) return;
    if (!socket.connected) {
      finished = true;
      cleanup();
      return;
    }
    if (connection.readyState !== 'open' || connection.transport.writable) {
      disconnect();
      return;
    }

    pendingTransport = connection.transport;
    onReady = () => {
      // Engine.IO's own ready listener flushes queued packets first. Inspect on
      // the following turn so a newly-started write can finish before close.
      deferExecutorTransportWork(inspectTransport);
    };
    pendingTransport.once('ready', onReady);
  };

  socket.once('disconnect', onSocketDisconnect);
  deadline = setTimeout(disconnect, EXECUTOR_REVOCATION_TRANSPORT_CLEANUP_TIMEOUT_MS);
  deadline.unref?.();
  if (!waitForAcknowledgement) deferExecutorTransportWork(inspectTransport);
  return () => {
    // The wrapped Feathers callback has synchronously handed the response to
    // Socket.IO's encoder. Only now is transport writability meaningful.
    deferExecutorTransportWork(inspectTransport);
  };
}

function bearerTokenFromHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
  return match?.[1];
}

/**
 * Create Socket.io configuration callback for FeathersJS
 *
 * This returns the configuration object and callback function that can be passed
 * to `app.configure(socketio(options, callback))`.
 *
 * Features:
 * - JWT authentication middleware
 * - Cursor presence events (cursor-move, cursor-leave)
 * - Connection tracking and metrics
 * - Graceful error handling
 *
 * @param app - FeathersJS application instance
 * @param options - Configuration options
 * @returns Socket.io server instance holder (populated after configure)
 */
export function createSocketIOConfig(
  app: Application,
  options: SocketIOOptions
): {
  serverOptions: object;
  callback: (io: Server) => void;
  getSocketServer: () => Server | null;
} {
  const { corsOrigin, credentialsAllowed, buildInfo } = options;
  const multiTenancy = options.multiTenancy;
  const executorRevocationFence = getOrCreateExecutorConnectionRevocationFence(app);
  // Default ON to mirror the daemon-wide default (see register-hooks.ts).
  const webTerminalEnabled = options.webTerminalEnabled !== false;

  let socketServer: Server | null = null;

  const serverOptions = {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      // Mirror the HTTP CORS layer's credential decision. In wildcard mode
      // credentials must be off — leaving this hard-coded `true` creates a
      // policy-drift across transports.
      credentials: credentialsAllowed,
    },
    // Socket.io server options for better connection management
    pingTimeout: 60000, // How long to wait for pong before considering connection dead
    pingInterval: 25000, // How often to ping clients
    maxHttpBufferSize: SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
    transports: ['websocket', 'polling'], // Prefer WebSocket
    ...(options.adapter ? { adapter: options.adapter } : {}),
  };

  const callback = (io: Server) => {
    // Store Socket.io server instance for shutdown
    socketServer = io;
    options.onServerCreated?.(io);

    // Track active connections for periodic operational metrics.
    let activeConnections = 0;
    // Intentionally system-global: the aggregate keeps only a saturated count,
    // never socket, user, tenant, channel, or client metadata.
    let authenticationFailures = 0;
    // Machine and impersonation sockets are bounded capabilities and retire at
    // their verified bearer expiry. Ordinary user sockets keep the immutable
    // identity accepted at the handshake until disconnect or explicit
    // revocation; routine REST access-token rotation must not tear down PTYs or
    // subscriptions.
    const authorityExpiryTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
    // Feathers emits `disconnect` with its connection projection on explicit
    // logout. Native Socket.IO rooms are not Feathers channels, so close the
    // owning transport rather than leaving cursor/presence capabilities alive
    // after the authentication strategy has retired that projection.
    const socketByFeathersConnection = new WeakMap<object, Socket>();
    app.on('disconnect', (connection: unknown) => {
      if (!connection || typeof connection !== 'object') return;
      socketByFeathersConnection.get(connection)?.disconnect(true);
    });
    // Revokes captured terminal-subscription functions across disconnects.
    const terminalAuthGenerations = new WeakMap<Socket, number>();
    // Serialize subscription operations for one socket/channel. Socket.IO room
    // membership is a set, not reference-counted: overlapping join cleanup
    // must never remove another valid operation's membership.
    const terminalJoinQueues = new WeakMap<Socket, Map<string, Promise<void>>>();

    const bindServerSocketAuthority = (socket: FeathersSocket): object => {
      const connection = socket.feathers ?? {};
      socket.feathers = connection;
      installSocketAuthorityId(connection as Record<PropertyKey, unknown>, socket.id);
      return connection;
    };

    const invalidateTerminalRequestJoin = (socket: FeathersSocket): void => {
      terminalAuthGenerations.set(socket, (terminalAuthGenerations.get(socket) ?? 0) + 1);
      const connection = socket.feathers as TerminalRequestConnection | undefined;
      if (connection) Reflect.deleteProperty(connection, TERMINAL_REQUEST_JOIN_CHANNEL);
    };

    const clearAuthorityExpiry = (socket: Socket): void => {
      const timer = authorityExpiryTimers.get(socket);
      if (timer) clearTimeout(timer);
      authorityExpiryTimers.delete(socket);
    };

    const scheduleAuthorityExpiry = (socket: FeathersSocket, expiresAt?: number): boolean => {
      clearAuthorityExpiry(socket);
      if (!expiresAt || !Number.isFinite(expiresAt)) return true;
      if (expiresAt <= Date.now()) return false;

      const arm = (): void => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          // Retire synchronously before ending the namespace so no handler can
          // observe stale authority during disconnect propagation.
          retireSocketConnectionAuthority(app, socket.feathers);
          socket.disconnect(true);
          return;
        }
        const timer = setTimeout(arm, Math.min(remaining, 2_147_000_000));
        timer.unref?.();
        authorityExpiryTimers.set(socket, timer);
      };
      arm();
      return true;
    };

    /**
     * Give services a narrow, server-only way to subscribe the authenticated
     * socket that owns a Feathers request. The service derives the room from
     * trusted tenant/user/id state; clients never receive or invoke this
     * capability directly.
     */
    const bindTerminalRequestJoin = (socket: FeathersSocket): void => {
      const connection = socket.feathers as
        | (NonNullable<FeathersSocket['feathers']> & TerminalRequestConnection)
        | undefined;
      if (!connection) return;

      const boundAuth = getSocketAuthState(socket);
      const boundUserId = boundAuth.userId;
      const boundTenantId = boundAuth.tenant?.tenant_id;
      if (!boundUserId || boundAuth.isService || !boundTenantId) {
        Reflect.deleteProperty(connection, TERMINAL_REQUEST_JOIN_CHANNEL);
        return;
      }
      const boundGeneration = terminalAuthGenerations.get(socket) ?? 0;

      const isCurrentAllocation = (
        channel: string,
        allocation: TerminalAllocatedEvent
      ): boolean => {
        if (
          !socket.connected ||
          socket.feathers !== connection ||
          (terminalAuthGenerations.get(socket) ?? 0) !== boundGeneration
        ) {
          return false;
        }
        const currentAuth = getSocketAuthState(socket);
        if (
          currentAuth.isService ||
          currentAuth.userId !== boundUserId ||
          currentAuth.tenant?.tenant_id !== boundTenantId
        ) {
          return false;
        }
        const parsed = parseTerminalChannel(channel);
        return (
          typeof allocation?.userId === 'string' &&
          allocation.userId === boundUserId &&
          typeof allocation.terminalId === 'string' &&
          allocation.terminalId.length > 0 &&
          typeof allocation.branchId === 'string' &&
          allocation.branchId.length > 0 &&
          parsed?.tenantId === boundTenantId &&
          parsed.userId === allocation.userId &&
          parsed.terminalId === allocation.terminalId
        );
      };

      Object.defineProperty(connection, TERMINAL_REQUEST_JOIN_CHANNEL, {
        configurable: true,
        enumerable: false,
        value: async (channel: string, allocation: TerminalAllocatedEvent) => {
          if (!isCurrentAllocation(channel, allocation)) return false;
          let queues = terminalJoinQueues.get(socket);
          if (!queues) {
            queues = new Map();
            terminalJoinQueues.set(socket, queues);
          }
          const previous = queues.get(channel) ?? Promise.resolve();
          let release!: () => void;
          const turn = new Promise<void>((resolve) => {
            release = resolve;
          });
          const tail = previous.then(
            () => turn,
            () => turn
          );
          queues.set(channel, tail);

          await previous.catch(() => undefined);
          try {
            // The connection may have been retired while this operation waited
            // for an earlier join. Revalidate before touching room membership.
            if (!isCurrentAllocation(channel, allocation)) return false;
            // A redundant create for an established attachment needs no new
            // Socket.IO operation and therefore cannot disrupt membership if
            // a second join attempt would fail.
            if (socket.rooms.has(channel)) {
              socket.emit('terminal:allocated', allocation);
              return true;
            }
            try {
              await socket.join(channel);
            } catch {
              // Membership is checked below: an independently completed,
              // authorized join still satisfies the subscription boundary.
            }
            if (!socket.rooms.has(channel) || !isCurrentAllocation(channel, allocation)) {
              await socket.leave(channel);
              return false;
            }
            // Establish the terminal identity in the browser before the
            // executor can emit output/readiness on its separate connection.
            socket.emit('terminal:allocated', allocation);
            return true;
          } finally {
            release();
            if (queues.get(channel) === tail) {
              queues.delete(channel);
              if (queues.size === 0) terminalJoinQueues.delete(socket);
            }
          }
        },
      });
    };

    const logAuthenticated = (socket: Socket, userId?: string) => {
      console.log(
        userId
          ? `socket authenticated: ${socket.id} user:${shortId(userId)}`
          : `socket authenticated: ${socket.id} service`
      );
    };

    // SECURITY: authenticate the namespace handshake before Socket.IO emits
    // `connection`. The normal authentication service owns signature, token
    // type, user, tenant-claim, executor-authority, and revocation validation;
    // this transport boundary only extracts the bearer and commits the
    // strategy result to the Feathers connection.
    io.use(async (socket, next) => {
      const fs = socket as FeathersSocket;
      try {
        const connection = bindServerSocketAuthority(fs);
        const authToken =
          typeof socket.handshake.auth?.token === 'string'
            ? socket.handshake.auth.token
            : undefined;
        const headerToken = bearerTokenFromHeader(socket.handshake.headers?.authorization);
        if (authToken && headerToken && authToken !== headerToken) {
          throw new Error('Conflicting authentication credentials');
        }
        const token = authToken ?? headerToken;

        if (!token) {
          throw new Error('Authentication required');
        }

        const authentication = app.service('authentication') as unknown as {
          authenticate(
            data: { strategy: 'jwt'; accessToken: string },
            params: { provider: 'socketio'; connection: object },
            ...strategies: string[]
          ): Promise<object>;
          handleConnection(event: 'login', connection: object, result: object): Promise<void>;
        };
        const result = await authentication.authenticate(
          { strategy: 'jwt', accessToken: token },
          { provider: 'socketio', connection },
          'jwt'
        );
        await authentication.handleConnection('login', connection, result);
        const authority = getAuthenticatedConnectionAuthority(connection);
        if (!authority) throw new Error('Authenticated connection authority is unavailable');
        if (!isAuthenticatedConnectionAuthorityCurrent(authority, executorRevocationFence)) {
          throw new Error('Executor connection authority was revoked during connection setup');
        }
        if (multiTenancy && !authority.tenant) {
          // Fail closed if authentication and transport wiring ever drift: a
          // configured tenant-aware daemon must never accept an unscoped
          // connection merely because the strategy was constructed wrongly.
          throw new Error('Authenticated tenant authority is unavailable');
        }
        if (authority.expiresAt === undefined) {
          // Runtime Socket.IO credentials are bounded bearer capabilities.
          // A correctly signed but non-expiring JWT is not a valid connection
          // credential even if the underlying JWT library accepts its shape.
          throw new Error('Authenticated connection expiry is unavailable');
        }
        if (authority.expiresAt <= Date.now()) {
          throw new Error('Authentication token expired during connection setup');
        }
        if (authority.retireAtExpiry && !scheduleAuthorityExpiry(fs, authority.expiresAt)) {
          throw new Error('Authentication token expired during connection setup');
        }

        logAuthenticated(
          socket,
          authority.principal.kind === 'user' ? authority.principal.userId : undefined
        );
        next();
      } catch (error) {
        // An expired/invalid token on a (re)connecting socket is routine: the
        // client refreshes on the 401 we return below and retries. Log it as a
        // terse warning without a stack. Reserve the loud error+stack for
        // genuinely unexpected failures (absent/revoked authority, tenant drift,
        // or another invariant violation) that warrant investigation.
        const err = error as {
          code?: number;
          className?: string;
          message?: string;
          data?: { name?: string };
        };
        const expected =
          err?.code === 401 ||
          err?.className === 'not-authenticated' ||
          err?.data?.name === 'TokenExpiredError' ||
          /jwt expired|token expired/i.test(err?.message ?? '');
        if (expected) {
          const reason =
            err?.data?.name === 'TokenExpiredError'
              ? 'token expired'
              : (err?.message ?? 'not authenticated');
          console.warn(`WebSocket auth rejected for ${socket.id}: ${reason}`);
        } else {
          console.error(`❌ WebSocket authentication failed for ${socket.id}:`, error);
        }
        authenticationFailures = Math.min(authenticationFailures + 1, Number.MAX_SAFE_INTEGER);
        retireSocketConnectionAuthority(app, fs.feathers);
        const publicError = new Error('Invalid or expired authentication token') as Error & {
          data: { code: number; className: string };
        };
        // Socket.IO preserves middleware-error `data` on connect_error. Keep
        // the public message deliberately generic while giving clients a
        // structured signal that it is safe to attempt refresh rather than
        // misreporting an authentication rejection as daemon downtime.
        publicError.data = { code: 401, className: 'not-authenticated' };
        next(publicError);
      }
    });

    // One input-target executor socket per process-local terminal attachment.
    // This registry is intentionally not shared through Redis: losing this
    // daemon boot ends the attachment instead of ambiguously adopting a PTY.
    const activeTerminalExecutorById = new Map<string, string>();

    // Tenant/branch-qualified lifecycle metadata may cross the adapter; PTY
    // contents and commands never do. This lets archive/delete ask whichever
    // replica owns an attachment to retire it without a distributed PTY.
    io.on('terminal:close-branch', (data: { tenantId?: string; branchId?: string }) => {
      if (data?.tenantId && data?.branchId) app.emit('terminal:close-branch', data);
    });

    app.on('terminal:shutdown-local', (data: { terminalId?: string; userId?: string }) => {
      if (!data.terminalId || !data.userId) return;
      const socketId = activeTerminalExecutorById.get(data.terminalId);
      if (socketId) {
        // Fence first: even if the executor emits synchronously while handling
        // shutdown, it is no longer authoritative for this attachment.
        activeTerminalExecutorById.delete(data.terminalId);
        io.local.to(socketId).emit('terminal:shutdown', data);
      }
    });

    const invalidateTenantAuthorization = (data: RealtimeAuthorizationInvalidation): void => {
      if (
        typeof data?.tenantId !== 'string' ||
        data.tenantId.length === 0 ||
        data.tenantId.length > MAX_TENANT_ID_LENGTH
      ) {
        return;
      }
      // Additive authorization changes need distributed cache coherence but do
      // not invalidate an already-authorized passive room capability. Avoid
      // tearing down the mutation's own Socket.IO RPC before its acknowledgement
      // and avoid forcing every tenant user through an unnecessary reconnect.
      if (data.disconnectSockets === false) {
        app.emit(LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT, { tenantId: data.tenantId });
        return;
      }
      // Clear replica-local authorization capabilities before disconnecting.
      // A reconnect can land on this same replica immediately and must not
      // inherit a warmed pre-revocation ACL cache or terminal allocation.
      app.emit(LOCAL_AUTHORIZATION_INVALIDATION_EVENT, { tenantId: data.tenantId });
      for (const socket of io.sockets.sockets.values()) {
        if (getSocketAuthState(socket).tenant?.tenant_id === data.tenantId) {
          socket.disconnect(true);
        }
      }
    };

    // RBAC/token mutations evict passive room capabilities. Reconnect forces
    // fresh authentication and every board/session subscription to pass its
    // current authorization check. In HA mode, the internal server-side event
    // applies the same fence on every replica; it never targets a client room.
    app.on('realtime:authorization-invalidated', (data: RealtimeAuthorizationInvalidation) => {
      invalidateTenantAuthorization(data);
      if (options.adapter) {
        io.serverSideEmit(HA_AUTHORIZATION_INVALIDATION_EVENT, data);
      }
    });
    io.on(HA_AUTHORIZATION_INVALIDATION_EVENT, invalidateTenantAuthorization);

    const evictRevokedExecutorSockets = (data: ExecutorSessionTokenRevocation): void => {
      const tenantId =
        typeof data?.tenantId === 'string' &&
        data.tenantId.length > 0 &&
        data.tenantId.length <= MAX_TENANT_ID_LENGTH
          ? data.tenantId
          : undefined;
      if (multiTenancy && !tenantId) return;
      const tokenFingerprint =
        typeof data?.tokenFingerprint === 'string' && /^[a-f0-9]{64}$/.test(data.tokenFingerprint)
          ? data.tokenFingerprint
          : undefined;
      if (!tokenFingerprint) return;

      const revocation: ExecutorSessionTokenRevocation = {
        ...(tenantId ? { tenantId } : {}),
        tokenFingerprint,
      };
      // Fence first. Authentication may have completed its database authority
      // read but not yet reached the final synchronous authenticated-connection
      // commit; changing this generation prevents that stale result from
      // installing a room capability after the scan below has already run.
      executorRevocationFence.record(revocation);

      for (const socket of io.sockets.sockets.values()) {
        const feathers = (socket as FeathersSocket).feathers;
        const authority = getAuthenticatedConnectionAuthority(feathers);
        if (authority?.principal.kind !== 'executor') continue;
        if (tenantId && authority.tenant?.tenant_id !== tenantId) continue;
        if (authority.principal.tokenFingerprint === tokenFingerprint) {
          // Retire the Feathers projection synchronously so no subsequent RPC
          // can reuse the lease. Drain the terminal lifecycle acknowledgement
          // before closing so a successful durable write is not reported as a
          // task failure by the executor.
          retireSocketConnectionAuthority(app, feathers);
          const rpc = executorRpcAcknowledgement.getStore();
          const waitsForThisRpc = rpc?.socket === socket;
          const acknowledgeRetirement = disconnectRevokedExecutorAfterTransportDrain(
            socket,
            waitsForThisRpc
          );
          if (waitsForThisRpc) {
            rpc.revoked = true;
            rpc.acknowledgeRetirement = acknowledgeRetirement;
          }
        }
      }
    };

    app.on('realtime:executor-token-invalidated', (data: ExecutorSessionTokenRevocation) => {
      evictRevokedExecutorSockets(data);
      if (options.adapter && data.tenantId) {
        io.serverSideEmit(HA_EXECUTOR_TOKEN_INVALIDATION_EVENT, data);
      }
    });
    io.on(HA_EXECUTOR_TOKEN_INVALIDATION_EVENT, evictRevokedExecutorSockets);

    // Configure Socket.io for cursor presence events
    io.on('connection', (socket) => {
      const feathersSocket = socket as FeathersSocket;
      bindServerSocketAuthority(feathersSocket);
      const authority = getAuthenticatedConnectionAuthority(feathersSocket.feathers);
      if (
        authority &&
        !isAuthenticatedConnectionAuthorityCurrent(authority, executorRevocationFence)
      ) {
        retireSocketConnectionAuthority(app, feathersSocket.feathers);
        socket.disconnect(true);
        return;
      }
      activeConnections++;
      // Bind revocation to the exact Feathers acknowledgement whose service
      // call caused it. A next-turn/idle-transport heuristic is insufficient:
      // Feathers invokes this callback only after the service promise returns,
      // and a disconnect may otherwise overtake the response encoder.
      if (authority?.principal.kind === 'executor')
        socket.use?.((packet, next) => {
          const lastIndex = packet.length - 1;
          const acknowledgement = packet[lastIndex];
          if (typeof acknowledgement !== 'function') {
            next();
            return;
          }
          const rpc: ExecutorRpcAcknowledgement = { socket, revoked: false };
          packet[lastIndex] = (...args: unknown[]) => {
            acknowledgement(...args);
            if (rpc.revoked) rpc.acknowledgeRetirement?.();
          };
          executorRpcAcknowledgement.run(rpc, next);
        });
      bindTerminalRequestJoin(feathersSocket);
      console.debug(
        `🔌 Socket.io connection established: ${socket.id} (auth: handshake, principal: ${authority?.principal.kind ?? 'invalid'}, user: ${authority?.principal.kind === 'user' ? shortId(authority.principal.userId) : 'none'}, total: ${activeConnections})`
      );

      // Welcome event: ship the daemon's build identity so UI tabs can spot
      // FE/BE drift after a deploy without waiting for the next /health poll.
      // The connection event runs only after authentication succeeds.
      if (buildInfo) {
        socket.emit('server-info', {
          buildSha: buildInfo.sha,
          builtAt: buildInfo.builtAt,
          ...(options.workIdentity
            ? {
                instanceId: options.workIdentity.instanceId,
                bootId: options.workIdentity.bootId,
              }
            : {}),
        });
      }

      // Auto-join per-user room for user-scoped events (OAuth prompts, notifications).
      // Terminal-executor identities are excluded from ALL room/channel joins —
      // they only ever consume raw `terminal:*` events on their own
      // tenant/user/terminal-qualified room, never Feathers channel broadcasts, so channel
      // membership would just hand them a firehose subscription they must not have.
      if (authority?.principal.kind === 'user') {
        const tenantId = authority.tenant?.tenant_id;
        if (tenantId) {
          socket.join(tenantChannelName(tenantId));
          socket.join(tenantUserChannelName(tenantId, authority.principal.userId));
        }
        console.debug(
          `🏠 Socket ${socket.id} joined user room at connection: user:${shortId(authority.principal.userId)}`
        );
      }

      // A terminal-executor identity has zero non-terminal daemon visibility:
      // it must not watch board presence rooms or emit/receive cursor+presence
      // activity (it would otherwise spoof presence and observe collaborators).
      // Presence/cursor events run outside Feathers hooks, so they're guarded
      // here directly, consistent with the channel-join exclusions.
      const isTerminalExecutorSocket = () =>
        getAuthenticatedConnectionAuthority((socket as FeathersSocket).feathers)?.principal.kind ===
        'terminal-executor';
      const getTenantId = () => getSocketAuthState(socket).tenant?.tenant_id;
      const presenceSocket = socket as FeathersSocket;
      presenceSocket.data.presenceId = randomUUID();
      const boundPresenceUserId =
        authority?.principal.kind === 'user' ? authority.principal.userId : undefined;
      const boundPresenceTenantId = authority?.tenant?.tenant_id;
      if (presenceSocket.feathers && typeof presenceSocket.feathers === 'object') {
        socketByFeathersConnection.set(presenceSocket.feathers, socket);
      }
      const allowCursorMove = createTokenBucket(
        CURSOR_MOVE_RATE_LIMIT.capacity,
        CURSOR_MOVE_RATE_LIMIT.refillPerSec
      );
      const allowCursorWatch = createTokenBucket(
        CURSOR_WATCH_RATE_LIMIT.capacity,
        CURSOR_WATCH_RATE_LIMIT.refillPerSec
      );
      const allowPresenceHeartbeat = createTokenBucket(
        PRESENCE_HEARTBEAT_RATE_LIMIT.capacity,
        PRESENCE_HEARTBEAT_RATE_LIMIT.refillPerSec
      );
      const allowPresenceSubscription = createTokenBucket(
        PRESENCE_SUBSCRIPTION_RATE_LIMIT.capacity,
        PRESENCE_SUBSCRIPTION_RATE_LIMIT.refillPerSec
      );

      const emitPresenceLeft = (boardId?: BoardID) => {
        const presenceId = presenceSocket.data.presenceId;
        if (!boundPresenceUserId || !boundPresenceTenantId || !presenceId) return;
        const event: PresenceLeftEvent = {
          userId: boundPresenceUserId,
          presenceId,
          ...(boardId ? { boardId } : {}),
          timestamp: Date.now(),
        };
        emitHaNativeSocketEvent(
          socket.broadcast.to(
            boardId
              ? boardPresenceAssociationRoomName(boundPresenceTenantId, boardId)
              : tenantChannelName(boundPresenceTenantId)
          ),
          PRESENCE_SOCKET_EVENTS.left,
          event
        );
      };

      const clearPublishedPresence = () => {
        if (!presenceSocket.data.presenceActive) return;
        const previousBoardId = presenceSocket.data.presenceBoardId;
        if (previousBoardId) emitPresenceLeft(previousBoardId);
        emitPresenceLeft();
        delete presenceSocket.data.presenceActive;
        delete presenceSocket.data.presenceBoardId;
        delete presenceSocket.data.lastTenantPresenceEmitAt;
        delete presenceSocket.data.lastBoardPresenceEmitAt;
      };

      const currentPresenceIdentity = (): {
        userId: string;
        tenantId: string;
        presenceId: string;
      } | null => {
        const auth = getSocketAuthState(socket);
        const tenantId = auth.tenant?.tenant_id;
        const presenceId = presenceSocket.data.presenceId;
        if (
          !auth.userId ||
          auth.userId !== boundPresenceUserId ||
          !tenantId ||
          tenantId !== boundPresenceTenantId ||
          !presenceId
        ) {
          return null;
        }
        return { userId: auth.userId, tenantId, presenceId };
      };

      const publishTenantLiveness = (identity = currentPresenceIdentity(), now = Date.now()) => {
        if (!identity) return;
        if (
          presenceSocket.data.presenceActive &&
          presenceSocket.data.lastTenantPresenceEmitAt &&
          now - presenceSocket.data.lastTenantPresenceEmitAt < GLOBAL_PRESENCE_EMIT_INTERVAL_MS
        ) {
          return;
        }

        const tenantPresence: PresenceUpdatedEvent = {
          userId: identity.userId,
          presenceId: identity.presenceId,
          timestamp: now,
        };
        emitHaNativeSocketEvent(
          socket.broadcast.to(tenantChannelName(identity.tenantId)),
          PRESENCE_SOCKET_EVENTS.updated,
          tenantPresence
        );
        presenceSocket.data.presenceActive = true;
        presenceSocket.data.lastTenantPresenceEmitAt = now;
      };

      const publishAuthorizedBoardAssociation = (boardId?: BoardID) => {
        const identity = currentPresenceIdentity();
        if (!identity) return;
        const previousBoardId = presenceSocket.data.presenceBoardId;
        const now = Date.now();
        const changed = previousBoardId !== boardId;
        if (previousBoardId && changed) emitPresenceLeft(previousBoardId);
        if (
          boardId &&
          (changed ||
            !presenceSocket.data.lastBoardPresenceEmitAt ||
            now - presenceSocket.data.lastBoardPresenceEmitAt >= GLOBAL_PRESENCE_EMIT_INTERVAL_MS)
        ) {
          emitHaNativeSocketEvent(
            socket.broadcast.to(boardPresenceAssociationRoomName(identity.tenantId, boardId)),
            PRESENCE_SOCKET_EVENTS.updated,
            {
              userId: identity.userId,
              presenceId: identity.presenceId,
              boardId,
              timestamp: now,
            }
          );
          presenceSocket.data.lastBoardPresenceEmitAt = now;
        }
        if (boardId) presenceSocket.data.presenceBoardId = boardId;
        else {
          delete presenceSocket.data.presenceBoardId;
          delete presenceSocket.data.lastBoardPresenceEmitAt;
        }
      };

      socket.on(
        PRESENCE_SOCKET_EVENTS.watchBoardCursors,
        async (boardId: string, acknowledgement?: unknown) => {
          const acknowledge = normalizeAcknowledgement<{ ok: boolean }>(acknowledgement);
          const auth = getSocketAuthState(socket);
          if (!auth.userId || isTerminalExecutorSocket()) return acknowledge?.({ ok: false });
          if (!isBoundedBoardId(boardId)) return acknowledge?.({ ok: false });
          if (!auth.tenant?.tenant_id) return acknowledge?.({ ok: false });
          if (!allowCursorWatch()) return acknowledge?.({ ok: false });
          const fs = socket as FeathersSocket;
          if (fs.data.authorizedBoardIds?.has(boardId)) {
            acknowledge?.({ ok: true });
            return;
          }
          fs.data.pendingCursorBoardAdmissions ??= new Map();
          if (
            fs.data.pendingCursorBoardAdmissions.has(boardId) ||
            (fs.data.authorizedBoardIds?.size ?? 0) + fs.data.pendingCursorBoardAdmissions.size >=
              MAX_PRESENCE_BOARD_SUBSCRIPTIONS
          ) {
            return acknowledge?.({ ok: false });
          }
          const requestedBoardId = boardId;
          const admission = Symbol(boardId);
          fs.data.pendingCursorBoardAdmissions.set(requestedBoardId, admission);
          try {
            try {
              // Raw Socket.IO rooms bypass Feathers publication hooks, so perform
              // the normal authenticated boards.get authorization before granting
              // membership. Tenant-qualified room names alone are not branch/board
              // authorization and Redis prefixes are never treated as auth.
              const board = (await app.service('boards').get(boardId, {
                ...(fs.feathers ?? {}),
                provider: 'socketio',
                connection: fs.feathers,
                tenant: auth.tenant,
                [FEATHERS_INSTRUMENTATION_REASON]: 'presence_cursor_admission',
              } as never)) as Board;
              if (
                board.archived ||
                !isBoundedBoardId(board.board_id) ||
                board.board_id !== requestedBoardId
              ) {
                return acknowledge?.({ ok: false });
              }
              boardId = board.board_id;
            } catch {
              return acknowledge?.({ ok: false });
            }

            // Authorization above is asynchronous. The connection authority is
            // immutable, but a disconnect or revocation may land while the read
            // is in flight; never restore a room to a retired connection.
            const currentAuth = getSocketAuthState(socket);
            if (
              !socket.connected ||
              currentAuth.userId !== auth.userId ||
              currentAuth.tenant?.tenant_id !== auth.tenant.tenant_id ||
              fs.data.pendingCursorBoardAdmissions.get(requestedBoardId) !== admission
            ) {
              return acknowledge?.({ ok: false });
            }
            fs.data.authorizedBoardIds ??= new Set();
            fs.data.authorizedBoardIds.add(boardId);
            socket.join(boardPresenceRoomName(auth.tenant.tenant_id, boardId));
            acknowledge?.({ ok: true });
          } finally {
            if (fs.data.pendingCursorBoardAdmissions.get(requestedBoardId) === admission) {
              fs.data.pendingCursorBoardAdmissions.delete(requestedBoardId);
            }
          }
        }
      );

      socket.on(PRESENCE_SOCKET_EVENTS.unwatchBoardCursors, (boardId: string) => {
        if (!isBoundedBoardId(boardId)) return;
        const tenantId = getTenantId();
        if (!tenantId) return;
        (socket as FeathersSocket).data.pendingCursorBoardAdmissions?.delete(boardId);
        socket.leave(boardPresenceRoomName(tenantId, boardId));
        (socket as FeathersSocket).data.authorizedBoardIds?.delete(boardId);
      });

      const applyPresenceSubscription = async (
        subscription: PendingPresenceSubscription
      ): Promise<boolean> => {
        const auth = getSocketAuthState(socket);
        if (!auth.userId || !auth.tenant?.tenant_id || !socket.connected) return false;

        let boards: Board[] = [];
        if (subscription.boardIds.length > 0) {
          const result = await app.service('boards').find({
            ...(presenceSocket.feathers ?? {}),
            provider: 'socketio',
            connection: presenceSocket.feathers,
            tenant: auth.tenant,
            paginate: false,
            query: {
              board_id: { $in: subscription.boardIds },
              archived: false,
              lean: true,
              $limit: MAX_PRESENCE_BOARD_SUBSCRIPTIONS,
            },
          } as never);
          boards = boardsFromServiceResult(result);
        }

        const currentAuth = getSocketAuthState(socket);
        if (
          !socket.connected ||
          currentAuth.userId !== auth.userId ||
          currentAuth.tenant?.tenant_id !== auth.tenant.tenant_id
        ) {
          return false;
        }
        // A newer full-set request supersedes this result before it can alter
        // passive room membership. Only one authorization read plus one latest
        // desired set are retained per socket.
        if (subscription.generation !== presenceSocket.data.presenceSubscriptionGeneration) {
          return false;
        }

        const requested = new Set(subscription.boardIds);
        const authorized = new Set(
          boards
            .filter(
              (board) =>
                !board.archived && isBoundedBoardId(board.board_id) && requested.has(board.board_id)
            )
            .map((board) => board.board_id as string)
        );
        const previous = presenceSocket.data.presenceAssociationBoardIds ?? new Set<string>();
        if (
          presenceSocket.data.presenceBoardId &&
          !authorized.has(presenceSocket.data.presenceBoardId)
        ) {
          // Full-set removal retracts only the association capability. Tenant
          // liveness is a separate signal and cursor traffic cannot restore it.
          publishAuthorizedBoardAssociation();
        }
        await Promise.all([
          ...[...previous]
            .filter((boardId) => !authorized.has(boardId))
            .map((boardId) =>
              socket.leave(boardPresenceAssociationRoomName(auth.tenant!.tenant_id, boardId))
            ),
          ...[...authorized]
            .filter((boardId) => !previous.has(boardId))
            .map((boardId) =>
              socket.join(boardPresenceAssociationRoomName(auth.tenant!.tenant_id, boardId))
            ),
        ]);
        presenceSocket.data.presenceAssociationBoardIds = authorized;
        if (subscription.generation !== presenceSocket.data.presenceSubscriptionGeneration) {
          return false;
        }
        presenceSocket.data.hasPresenceAssociationSubscription = true;
        return true;
      };

      const drainPresenceSubscriptions = async (): Promise<void> => {
        if (presenceSocket.data.presenceSubscriptionRunning) return;
        presenceSocket.data.presenceSubscriptionRunning = true;
        try {
          while (socket.connected) {
            const subscription = presenceSocket.data.pendingPresenceSubscription;
            if (!subscription) break;
            delete presenceSocket.data.pendingPresenceSubscription;
            let ok = false;
            try {
              ok = await applyPresenceSubscription(subscription);
            } catch {
              ok = false;
            }
            subscription.acknowledge?.({ ok });
          }
        } finally {
          delete presenceSocket.data.presenceSubscriptionRunning;
          if (socket.connected && presenceSocket.data.pendingPresenceSubscription) {
            void drainPresenceSubscriptions();
          }
        }
      };

      socket.on(
        PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations,
        (request: BoardPresenceSubscriptionRequest, acknowledgement?: unknown) => {
          const acknowledge =
            normalizeAcknowledgement<PresenceSubscriptionAcknowledgement>(acknowledgement);
          const boardIds = request?.boardIds;
          if (
            !Array.isArray(boardIds) ||
            boardIds.length > MAX_PRESENCE_BOARD_SUBSCRIPTIONS ||
            !boardIds.every(isBoundedBoardId)
          ) {
            acknowledge?.({ ok: false });
            return;
          }
          const requestedBoardIds = [...new Set(boardIds)];
          const generation = (presenceSocket.data.presenceSubscriptionGeneration ?? 0) + 1;
          presenceSocket.data.presenceSubscriptionGeneration = generation;
          // Every valid full-set generation invalidates publisher authority,
          // even when the recipient room set is unchanged. A later heartbeat
          // cannot reuse an older successful grant while this generation is
          // slow, superseded, rate-limited, or rejected.
          publishAuthorizedBoardAssociation();
          delete presenceSocket.data.hasPresenceAssociationSubscription;
          // Superseded pending work is acknowledged negatively immediately so
          // neither the browser nor daemon retains an unbounded callback queue.
          presenceSocket.data.pendingPresenceSubscription?.acknowledge?.({ ok: false });
          delete presenceSocket.data.pendingPresenceSubscription;
          if (requestedBoardIds.length > 0 && !allowPresenceSubscription()) {
            acknowledge?.({ ok: false });
            return;
          }
          presenceSocket.data.pendingPresenceSubscription = {
            generation,
            boardIds: requestedBoardIds,
            acknowledge,
          };
          void drainPresenceSubscriptions();
        }
      );

      socket.on(PRESENCE_SOCKET_EVENTS.heartbeat, (data: PresenceHeartbeatEvent) => {
        const boardId = data?.boardId;
        if (boardId !== undefined && boardId !== null && !isBoundedBoardId(boardId)) return;
        publishTenantLiveness();
        if (boardId === undefined || boardId === null) {
          publishAuthorizedBoardAssociation();
          return;
        }
        if (!allowPresenceHeartbeat()) return;
        if (
          presenceSocket.data.presenceSubscriptionRunning ||
          !presenceSocket.data.hasPresenceAssociationSubscription ||
          !presenceSocket.data.presenceAssociationBoardIds?.has(boardId)
        ) {
          return;
        }
        publishAuthorizedBoardAssociation(boardId);
      });

      socket.on(PRESENCE_SOCKET_EVENTS.leave, clearPublishedPresence);

      // Handle cursor movement events
      socket.on(PRESENCE_SOCKET_EVENTS.cursorMove, (data: CursorMoveEvent) => {
        if (!isCursorMoveEvent(data)) return;
        if (!allowCursorMove()) return;
        // One immutable-authority projection plus the in-memory board grant is
        // the entire per-sample authorization path. Never put a Feathers/DB
        // lookup in this high-frequency handler: admission and revocation own
        // that work at connection/room boundaries.
        const identity = currentPresenceIdentity();
        if (!identity) return;
        const fs = socket as FeathersSocket;
        if (!fs.data.authorizedBoardIds?.has(data.boardId)) return;
        const previousBoardId = fs.data.currentBoardId;
        const timestamp = Date.now();

        if (previousBoardId && previousBoardId !== data.boardId) {
          const left: CursorLeftEvent = {
            userId: identity.userId,
            presenceId: identity.presenceId,
            boardId: previousBoardId,
            timestamp,
          };
          emitHaNativeSocketEvent(
            socket.broadcast.to(boardPresenceRoomName(identity.tenantId, previousBoardId)),
            PRESENCE_SOCKET_EVENTS.cursorLeft,
            left
          );
        }

        const broadcastData: CursorMovedEvent = {
          userId: identity.userId,
          presenceId: identity.presenceId,
          boardId: data.boardId,
          x: data.x,
          y: data.y,
          timestamp,
        };

        // Cursor samples are lossy state, not an event log. Volatile fanout
        // prevents a slow/recovering transport from buffering stale positions;
        // leave/presence edge events intentionally remain reliable.
        emitHaNativeSocketEvent(
          socket.broadcast.to(boardPresenceRoomName(identity.tenantId, data.boardId)).volatile,
          PRESENCE_SOCKET_EVENTS.cursorMoved,
          broadcastData
        );

        fs.data.currentBoardId = data.boardId;
        // Cursor authorization and navbar association authorization are
        // intentionally separate. Cursor traffic refreshes only tenant-wide
        // liveness and can never assert a board association.
        publishTenantLiveness(identity, timestamp);
      });

      // Handle cursor leave events (user navigates away from board)
      socket.on(PRESENCE_SOCKET_EVENTS.cursorLeave, (data: CursorLeaveEvent) => {
        const identity = currentPresenceIdentity();
        if (!identity) return;
        const fs = socket as FeathersSocket;
        if (!isBoundedBoardId(data?.boardId) || !fs.data.authorizedBoardIds?.has(data.boardId)) {
          return;
        }
        if (fs.data.currentBoardId !== data.boardId) return;
        // Make leave edge-triggered before fanout. Repeated caller packets can
        // no longer amplify one accepted, rate-limited cursor move into
        // unbounded Redis traffic.
        delete fs.data.currentBoardId;

        emitHaNativeSocketEvent(
          socket.broadcast.to(boardPresenceRoomName(identity.tenantId, data.boardId)),
          PRESENCE_SOCKET_EVENTS.cursorLeft,
          {
            userId: identity.userId,
            presenceId: identity.presenceId,
            boardId: data.boardId,
            timestamp: Date.now(),
          }
        );
      });

      // =========================================================================
      // TERMINAL CHANNEL SUPPORT
      //
      // Executors and browsers join tenant/user/terminal-qualified channels and
      // exchange PTY I/O over them. Auth model:
      //
      //   Browser → daemon (relayed to executor):
      //     - terminal:input    requires user auth + payload.userId === self
      //     - terminal:resize   requires user auth + payload.userId === self
      //
      //   Executor → daemon (relayed to browser):
      //     - terminal:output   requires service auth
      //     - terminal:exit     requires service auth
      //     - terminal:tab      requires service auth
      //                         (the daemon ALSO emits terminal:tab via
      //                          io.to(...) directly from terminals.ts after
      //                          enforcing branch RBAC at the HTTP layer;
      //                          server-side emits never hit this handler.)
      //
      //   join / leave:
      //     - require user auth
      //     - channel tenant, user, terminal, and owner boot must match the
      //       authenticated identity/capability.
      //
      //   Branch RBAC for opening a terminal against a specific branch
      //   is enforced at the HTTP `terminals.create({ branchId })` entry
      //   point (see services/terminals.ts ~L194). Browsers cannot bypass
      //   that gate from the WS side, because creating a Zellij tab in an
      //   arbitrary branch requires terminal:tab — and only service-token
      //   sockets are allowed to emit terminal:tab here.
      //
      //   `webTerminalEnabled === false` short-circuits ALL of the above —
      //   the kill-switch must work for both transports, not just HTTP.
      // =========================================================================

      // Per-socket rate limiter for terminal:input. Generous cap (500/s,
      // burst 1000) — enough for bracketed paste of large blocks, low enough
      // to defang a hijacked or malfunctioning client trying to flood the
      // executor PTY or the daemon log.
      const inputRateLimit = createTokenBucket(1000, 500);

      const rejectTerminal = (event: string, reason: string) => {
        const auth = getSocketAuthState(socket);
        console.warn(
          `🚫 ${event} rejected on socket ${socket.id}: ${reason} ` +
            `(authenticated=${isAuthenticated(auth)} service=${auth.isService} ` +
            `executor=${auth.isExecutor === true} tenantBound=${!!auth.tenant} ` +
            `terminalScoped=${!!auth.terminalId})`
        );
      };

      const matchesLocalTerminalAttachment = (auth: SocketAuthState): boolean => {
        if (
          !auth.terminalId ||
          !auth.tenant?.tenant_id ||
          !auth.terminalUserId ||
          !auth.terminalBranchId ||
          !auth.terminalOwnerBootId
        ) {
          return false;
        }
        const terminals = app.service('terminals') as unknown as {
          matchesOwnedAttachment(identity: TerminalAttachmentIdentity): boolean;
        };
        return terminals.matchesOwnedAttachment({
          terminalId: auth.terminalId,
          tenantId: auth.tenant.tenant_id,
          userId: auth.terminalUserId,
          branchId: auth.terminalBranchId,
          ownerBootId: auth.terminalOwnerBootId,
        });
      };

      // Common preflight for browser-emitted terminal events. Returns the
      // authenticated user's id when the event should proceed, or null when
      // the event was rejected (and the caller must return).
      const requireUserForOwnUserId = (
        event: 'terminal:input' | 'terminal:resize',
        payloadUserId: unknown,
        payloadTerminalId: unknown
      ): { userId: string; terminalId: string; channel: string } | null => {
        if (!webTerminalEnabled) {
          rejectTerminal(event, 'web terminal disabled (allow_web_terminal=false)');
          return null;
        }
        const auth = getSocketAuthState(socket);
        if (!auth.userId) {
          rejectTerminal(event, 'no authenticated user');
          return null;
        }
        if (typeof payloadUserId !== 'string' || payloadUserId !== auth.userId) {
          // Critical: do NOT trust client-supplied userId. Mismatch = either
          // a forged payload (hijack attempt) or a buggy client. Either way,
          // refuse to relay.
          rejectTerminal(
            event,
            `payload userId (${shortId(String(payloadUserId))}…) does not match ` +
              `authed userId (${shortId(auth.userId)}…)`
          );
          return null;
        }
        if (typeof payloadTerminalId !== 'string' || !payloadTerminalId) {
          rejectTerminal(event, 'missing terminalId');
          return null;
        }
        const tenantId = auth.tenant?.tenant_id;
        if (!tenantId) {
          rejectTerminal(event, 'missing trusted tenant context');
          return null;
        }
        const channel = terminalChannelName(tenantId, auth.userId, payloadTerminalId);
        if (!socket.rooms.has(channel)) {
          rejectTerminal(event, 'socket is not attached to that terminal instance');
          return null;
        }
        return { userId: auth.userId, terminalId: payloadTerminalId, channel };
      };

      // Common preflight for executor-emitted terminal events
      // (output/exit/tab/ready/error). Requires a restricted terminal-executor
      // socket (`terminalUserId`, bound at spawn time) AND whose scope
      // matches the payload userId. The scope is required unconditionally: the
      // only legitimate emitter of these events is the terminal executor, which
      // always carries it, so a generic/unscoped service token has no business
      // driving another user's terminal. Returns true when the event may
      // proceed.
      const requireTerminalExecutorForOwnTerminal = (
        event: string,
        payloadUserId: unknown,
        payloadTerminalId: unknown
      ): SocketAuthState | null => {
        if (!webTerminalEnabled) {
          rejectTerminal(event, 'web terminal disabled (allow_web_terminal=false)');
          return null;
        }
        const auth = getSocketAuthState(socket);
        if (!auth.isService) {
          rejectTerminal(event, `only a terminal executor may emit ${event}`);
          return null;
        }
        if (typeof payloadUserId !== 'string' || !payloadUserId) {
          rejectTerminal(event, 'missing userId');
          return null;
        }
        if (!auth.terminalUserId) {
          rejectTerminal(event, 'terminal executor is not scoped to a user');
          return null;
        }
        if (auth.terminalUserId !== payloadUserId) {
          rejectTerminal(
            event,
            `terminal executor scoped to ${shortId(auth.terminalUserId)}… may not act for ` +
              `${shortId(payloadUserId)}…`
          );
          return null;
        }
        if (
          typeof payloadTerminalId !== 'string' ||
          !payloadTerminalId ||
          auth.terminalId !== payloadTerminalId
        ) {
          rejectTerminal(event, 'terminal executor is not scoped to this terminal instance');
          return null;
        }
        if (
          !auth.terminalOwnerBootId ||
          !options.workIdentity?.bootId ||
          auth.terminalOwnerBootId !== options.workIdentity.bootId
        ) {
          rejectTerminal(event, 'terminal owner boot fence does not match this daemon');
          return null;
        }
        if (!auth.tenant?.tenant_id) {
          rejectTerminal(event, 'missing trusted tenant context');
          return null;
        }
        if (!auth.terminalBranchId) {
          rejectTerminal(event, 'terminal executor is not scoped to a branch');
          return null;
        }
        if (!matchesLocalTerminalAttachment(auth)) {
          rejectTerminal(event, 'terminal attachment is no longer owned by this daemon');
          return null;
        }
        if (activeTerminalExecutorById.get(payloadTerminalId) !== socket.id) {
          rejectTerminal(event, 'executor socket is not active for this terminal attachment');
          return null;
        }
        return auth;
      };

      // Handle explicit channel joins (for terminal channels)
      socket.on('join', (channel: string) => {
        if (!webTerminalEnabled) {
          rejectTerminal('join', 'web terminal disabled (allow_web_terminal=false)');
          return;
        }
        const target = parseTerminalChannel(channel);
        if (!target) {
          console.warn(`⚠️  Socket ${socket.id} tried to join an invalid terminal channel`);
          return;
        }
        const auth = getSocketAuthState(socket);
        if (!isAuthenticated(auth)) {
          rejectTerminal('join', 'unauthenticated socket cannot join terminal channels');
          return;
        }
        // Channel membership determines who RECEIVES a user's terminal traffic
        // (output/input/resize), so it must be scoped to that user. A terminal
        // terminal executor capability is bound to one user (`terminalUserId`)
        // and may only join THAT user's channel — not any user's. A service
        // token with no terminal scope has no business on a terminal channel at
        // all. User sockets may only join their own channel.
        if (auth.tenant?.tenant_id !== target.tenantId) {
          rejectTerminal('join', 'terminal channel tenant does not match authenticated tenant');
          return;
        }
        // Browsers never possess a reusable raw-room capability. The only
        // browser join is performed server-side by TerminalsService.create
        // after its live branch permission check. This handler remains solely
        // for the terminal executor's exactly-scoped runtime token.
        if (!auth.isService) {
          rejectTerminal('join', 'browser terminal joins require an authorized allocation');
          return;
        }
        if (
          !auth.terminalUserId ||
          auth.terminalUserId !== target.userId ||
          !auth.terminalId ||
          auth.terminalId !== target.terminalId ||
          !auth.terminalBranchId ||
          !auth.terminalOwnerBootId ||
          auth.terminalOwnerBootId !== options.workIdentity?.bootId ||
          !matchesLocalTerminalAttachment(auth)
        ) {
          rejectTerminal(
            'join',
            'terminal executor scope or owner boot fence does not match the requested channel or live attachment'
          );
          return;
        }
        console.debug(`🖥️  Socket ${socket.id} joining its authorized terminal channel`);
        socket.join(channel);
        if (auth.terminalId === target.terminalId) {
          const prev = activeTerminalExecutorById.get(target.terminalId);
          if (prev && prev !== socket.id) {
            // Stop the replaced executor from observing any future frames even
            // if it ignores shutdown. The socket-id room remains available for
            // the direct control event after leaving the attachment room.
            io.sockets.sockets.get(prev)?.leave(channel);
            io.local.to(prev).emit('terminal:shutdown', {
              terminalId: target.terminalId,
              userId: target.userId,
            });
          }
          activeTerminalExecutorById.set(target.terminalId, socket.id);
        }
      });

      // Handle explicit channel leaves. Same scoping as join: a terminal
      // executor may only leave its own user's channel, users only their own.
      // We also reject for unauthenticated sockets to prevent noise / probing.
      socket.on('leave', (channel: string) => {
        const target = parseTerminalChannel(channel);
        if (!target) {
          console.warn(`⚠️  Socket ${socket.id} tried to leave an invalid terminal channel`);
          return;
        }
        const auth = getSocketAuthState(socket);
        if (!isAuthenticated(auth)) {
          rejectTerminal('leave', 'unauthenticated socket cannot leave terminal channels');
          return;
        }
        if (auth.tenant?.tenant_id !== target.tenantId) {
          rejectTerminal('leave', 'terminal channel tenant does not match authenticated tenant');
          return;
        }
        if (auth.isService) {
          if (
            !auth.terminalUserId ||
            auth.terminalUserId !== target.userId ||
            !auth.terminalId ||
            auth.terminalId !== target.terminalId
          ) {
            rejectTerminal('leave', 'terminal executor scope does not match the requested channel');
            return;
          }
        } else if (auth.userId !== target.userId) {
          rejectTerminal(
            'leave',
            `user ${auth.userId ? shortId(auth.userId) : 'unknown'}… tried to leave another user's terminal channel`
          );
          return;
        }
        console.debug(`🖥️  Socket ${socket.id} leaving its authorized terminal channel`);
        socket.leave(channel);
      });

      socket.on('disconnect', () => {
        for (const [terminalId, sid] of activeTerminalExecutorById) {
          if (sid === socket.id) activeTerminalExecutorById.delete(terminalId);
        }
      });

      // Route terminal output from executor to browser.
      // Executor emits: terminal:output { userId, data } → broadcast to channel
      // ONLY service sockets may emit this — otherwise a member could spoof
      // arbitrary output (e.g. fake "permission granted" prompts) into
      // another user's terminal.
      socket.on('terminal:output', (data: { userId: string; terminalId: string; data: string }) => {
        const auth = requireTerminalExecutorForOwnTerminal(
          'terminal:output',
          data?.userId,
          data?.terminalId
        );
        if (!auth) return;
        const channel = terminalChannelName(
          auth.tenant!.tenant_id,
          auth.terminalUserId!,
          auth.terminalId!
        );
        // `socket.to` (not `io.to`) excludes the sender. The executor joins
        // its own attachment channel to relay I/O, so `io.to` would
        // bounce every output frame straight back to the executor that just
        // produced it — a wasted round trip on the hottest path.
        socket.local.to(channel).emit('terminal:output', data);
      });

      // Route terminal input from browser to executor.
      // Browser emits: terminal:input { userId, input } → broadcast to channel
      // Auth: must be the authenticated user, and payload.userId MUST match.
      socket.on('terminal:input', (data: { userId: string; terminalId: string; input: string }) => {
        const target = requireUserForOwnUserId('terminal:input', data?.userId, data?.terminalId);
        if (!target) return;
        if (!inputRateLimit()) {
          rejectTerminal('terminal:input', 'rate limit exceeded (>500/s)');
          return;
        }
        // Re-derive the channel and userId from the AUTHENTICATED identity.
        // Even though we already validated payload.userId matches authed
        // userId above, we send the trusted value downstream so executors
        // never see attacker-controlled strings even if the check above is
        // ever weakened.
        const executor = activeTerminalExecutorById.get(target.terminalId);
        if (!executor) return;
        io.local.to(executor).emit('terminal:input', {
          userId: target.userId,
          terminalId: target.terminalId,
          input: data.input,
        });
      });

      // Route terminal resize events. Same auth model as terminal:input —
      // browser-emitted, must match authed user. Resize events aren't a
      // direct shell-injection vector but a hijacker could use them to
      // disrupt the victim's session, so we lock them down anyway.
      socket.on(
        'terminal:resize',
        (data: { userId: string; terminalId: string; cols: number; rows: number }) => {
          const target = requireUserForOwnUserId('terminal:resize', data?.userId, data?.terminalId);
          if (!target) return;
          const executor = activeTerminalExecutorById.get(target.terminalId);
          if (!executor) return;
          io.local.to(executor).emit('terminal:resize', {
            userId: target.userId,
            terminalId: target.terminalId,
            cols: data.cols,
            rows: data.rows,
          });
        }
      );

      // Route terminal tab commands. The daemon emits this server-side via
      // Socket.IO room targeting (terminals.ts) AFTER enforcing branch RBAC on the HTTP
      // create() path. We must NOT let browsers emit it directly — doing so
      // would let a user with 'view'-only on a branch open a Zellij tab
      // (and a shell) inside that branch, bypassing the HTTP RBAC gate.
      socket.on(
        'terminal:tab',
        (data: {
          userId: string;
          terminalId: string;
          action: string;
          tabName: string;
          cwd?: string;
        }) => {
          const auth = requireTerminalExecutorForOwnTerminal(
            'terminal:tab',
            data?.userId,
            data?.terminalId
          );
          if (!auth) return;
          const channel = terminalChannelName(
            auth.tenant!.tenant_id,
            auth.terminalUserId!,
            auth.terminalId!
          );
          io.local.to(channel).emit('terminal:tab', data);
        }
      );

      // Handle terminal exit notification from executor.
      // Executor-only — a forged exit would let a member terminate or
      // confuse another user's terminal session.
      socket.on(
        'terminal:exit',
        (data: { userId: string; terminalId: string; exitCode: number; signal?: number }) => {
          const auth = requireTerminalExecutorForOwnTerminal(
            'terminal:exit',
            data?.userId,
            data?.terminalId
          );
          if (!auth) return;
          // The TerminalsService owns attachment retirement and browser
          // notification. This event synchronously retires the registry entry
          // and emits terminal:shutdown-local, which fences this socket.
          app.emit('terminal:exit', data);
          activeTerminalExecutorById.delete(data.terminalId);
          console.log(
            `🖥️  Terminal exited user=${shortId(data.userId)} terminal=${shortId(data.terminalId)} code=${data.exitCode}`
          );
        }
      );

      // Executor readiness ack: the PTY exists and zellij is attached.
      // Executor-only — a forged ready could trick the daemon into driving
      // tab choreography (and the browser into showing "connected") against a
      // terminal that isn't actually up. Relayed to the TerminalsService via
      // an app event so it can gate its choreography on this instead of a
      // blind timer; the service is the sole authority that then notifies the
      // browser channel.
      socket.on(
        'terminal:ready',
        (data: { userId: string; terminalId: string; sessionName?: string; tabName?: string }) => {
          if (
            !requireTerminalExecutorForOwnTerminal('terminal:ready', data?.userId, data?.terminalId)
          ) {
            return;
          }
          app.emit('terminal:ready', data);
        }
      );

      // Executor attach-failure ack. Same user-scoped service trust as ready.
      socket.on(
        'terminal:error',
        (data: { userId: string; terminalId: string; message?: string }) => {
          if (
            !requireTerminalExecutorForOwnTerminal('terminal:error', data?.userId, data?.terminalId)
          ) {
            return;
          }
          app.emit('terminal:error', data);
        }
      );

      // Track disconnections
      socket.on('disconnect', (reason) => {
        // Server-internal lifecycle signal for socket-bound one-shot state.
        app.emit(AGOR_SOCKET_AUTHORITY_DISCONNECTED_EVENT, socket.id);
        activeConnections--;
        clearAuthorityExpiry(socket);
        clearPublishedPresence();
        if (presenceSocket.feathers && typeof presenceSocket.feathers === 'object') {
          socketByFeathersConnection.delete(presenceSocket.feathers);
        }
        invalidateTerminalRequestJoin(socket as FeathersSocket);
        retireSocketConnectionAuthority(app, (socket as FeathersSocket).feathers);
        const message = `🔌 Socket.io disconnected: ${socket.id} (reason: ${reason}, remaining: ${activeConnections})`;
        if (reason === 'transport error') {
          console.warn(message);
        } else if (reason === 'transport close' || reason === 'client namespace disconnect') {
          console.debug(message);
        } else {
          // Keep ping timeouts (and unexpected/rare reasons) visible at info.
          console.log(message);
        }
      });

      // Handle socket errors
      socket.on('error', (error) => {
        console.error(`❌ Socket.io error on ${socket.id}:`, error);
      });
    });

    // Emit a fixed-key gauge on a steady cadence so log collectors can parse it
    // and periods with no connection churn remain observable.
    const metricsInterval = setInterval(
      () => {
        const failedHandshakes = authenticationFailures;
        authenticationFailures = 0;
        console.log(
          `ws_active_connections=${activeConnections} ws_authentication_failures=${failedHandshakes}`
        );
      },
      5 * 60 * 1000
    );
    metricsInterval.unref();

    // Socket.io closes its Engine.IO server during application shutdown.
    io.engine.once('close', () => clearInterval(metricsInterval));
  };

  return {
    serverOptions,
    callback,
    getSocketServer: () => socketServer,
  };
}

/** Configure Feathers publication channels from immutable handshake authority. */
export function configureChannels(app: Application): void {
  const executorRevocationFence = getOrCreateExecutorConnectionRevocationFence(app);
  app.on('connection', (connection: unknown) => {
    const authority = getAuthenticatedConnectionAuthority(connection);
    if (
      !authority ||
      !isAuthenticatedConnectionAuthorityCurrent(authority, executorRevocationFence)
    ) {
      return;
    }

    // Terminal executors consume only their exactly-scoped raw terminal room.
    // They never enter Feathers publication channels.
    if (authority.principal.kind === 'terminal-executor') return;

    if (authority.principal.kind === 'executor') {
      const tenantId = authority.tenant?.tenant_id;
      if (tenantId && authority.principal.taskId) {
        joinExecutorTaskChannel(app, tenantId, authority.principal.taskId, connection);
      }
      return;
    }

    app.channel('authenticated').join(connection as never);
    const tenantId = authority.tenant?.tenant_id;
    if (!tenantId) return;
    app.channel(tenantChannelName(tenantId)).join(connection as never);
    if (authority.principal.kind === 'user') {
      app
        .channel(tenantUserChannelName(tenantId, authority.principal.userId))
        .join(connection as never);
    }
  });
}
