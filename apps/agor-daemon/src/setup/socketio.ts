/**
 * Socket.io Configuration
 *
 * Configures WebSocket server with authentication middleware,
 * cursor presence tracking, and connection management.
 *
 * SECURITY (terminal:* events):
 * Browser-emitted terminal events (terminal:input, terminal:resize, join)
 * are gated by per-event authentication checks. Without these checks any
 * anonymous socket that knew a target user_id could inject keystrokes into
 * that user's web terminal channel. In simple mode this is a shell as the
 * daemon user (with read access to ~/.agor/config.yaml,
 * agor.db, and the JWT secret). See `terminal:*` handlers below.
 */

import {
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
} from '@agor/core/config';
import { shortId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedUser,
  BoardID,
  CursorLeaveEvent,
  CursorMovedEvent,
  CursorMoveEvent,
  PresenceUpdatedEvent,
  TenantContext,
  TerminalAllocatedEvent,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';
import type { Server, ServerOptions, Socket } from 'socket.io';
import { isExecutorSessionTokenPayload } from '../auth/executor-session-token.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import { isTerminalExecutorIdentity } from '../auth/terminal-executor-guard.js';
import { assertUserTokenNotInvalidated } from '../auth/token-invalidation.js';
import {
  boardPresenceRoomName,
  emitHaNativeSocketEvent,
  HA_AUTHORIZATION_INVALIDATION_EVENT,
  isTenantRealtimeRoomName,
  parseTerminalChannel,
  tenantChannelName,
  tenantUserChannelName,
  terminalChannelName,
} from '../realtime/routing.js';
import type { TerminalAttachmentIdentity } from '../services/terminals.js';
import {
  TERMINAL_REQUEST_JOIN_CHANNEL,
  type TerminalRequestConnection,
} from '../terminal-socket-connection.js';
import {
  joinExecutorTaskChannel,
  leaveAllExecutorTaskChannels,
  leaveAllSessionStreamChannels,
  leaveAllTenantChannels,
} from '../utils/realtime-publish.js';
import type { BuildInfo } from './build-info.js';
import type { CorsOrigin } from './cors.js';

/**
 * FeathersJS extends Socket.io socket with authentication context.
 *
 * `feathers.user` is populated either:
 *   - synchronously by the io.use() handshake middleware below (handshake
 *     token path: user, service, or empty for anonymous-allowed), OR
 *   - asynchronously by FeathersJS itself when the client calls
 *     `client.authenticate()` after connect (login event).
 *
 * Service accounts (the executor) are identified via `user._isServiceAccount`,
 * which is the canonical marker set by ServiceJWTStrategy and consumed by
 * every other daemon authz path (branch-authorization.ts, register-hooks.ts,
 * utils/authorization.ts). We extend FeathersJS's `User` type locally to
 * include it — see `AuthenticatedUser` in `@agor/core/types/feathers.ts`.
 *
 * `socket.data.isService` is ALSO set in the handshake path as a fast-path
 * marker for sockets whose service token was presented at connect time (and
 * therefore have no feathers.user). Post-connect `client.authenticate()`
 * flows don't trip the handshake middleware, so `_isServiceAccount` on the
 * feathers user is the only reliable signal for those sockets.
 */
interface FeathersSocket extends Socket {
  feathers?: {
    // `AuthenticatedUser` is the shape Feathers JWT strategies attach to
    // params/connections — it already carries `_isServiceAccount?: boolean`.
    user?: AuthenticatedUser;
    authentication?: { accessToken?: string; payload?: unknown };
  };
  data: {
    isService?: boolean;
    /** Terminal user scope for handshake-token service sockets (see SocketAuthState). */
    terminalUserId?: string;
    terminalId?: string;
    terminalBranchId?: string;
    terminalOwnerBootId?: string;
    currentBoardId?: BoardID;
    /** Boards authorized through the Feathers boards.get hook on this socket. */
    authorizedBoardIds?: Set<string>;
    lastPresenceEmitAt?: number;
    tenant?: TenantContext;
  };
  handshake: Socket['handshake'] & { headers?: Record<string, string | string[] | undefined> };
}

export interface SocketIOOptions {
  /** CORS origin configuration */
  corsOrigin: CorsOrigin;
  /** JWT secret for token verification */
  jwtSecret: string;
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
  /** Resolved app-level multi-tenancy configuration for socket tenant binding. */
  multiTenancy?: ResolvedMultiTenancyConfig;
  /** Redis adapter constructor in explicit HA mode. */
  adapter?: ServerOptions['adapter'];
  /** Called as soon as Feathers creates the Socket.IO server. */
  onServerCreated?: (io: Server) => void;
}

/**
 * Auth state derived from a socket. Returned by {@link getSocketAuthState}.
 *
 * - `userId` is the authenticated user's id, or null for anonymous/service.
 * - `isService` is true for executor service tokens (no backing real user,
 *   but trusted).
 *
 * `isAuthenticated` is intentionally not a field — it's `!!(userId ||
 * isService)` and would only create drift between the two representations.
 * Callers that need it should compute `auth.userId !== null || auth.isService`.
 */
export interface SocketAuthState {
  userId: string | null;
  isService: boolean;
  /** Task-scoped executor tokens are authenticated but never user/service sockets. */
  isTaskExecutor?: boolean;
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
  isTaskExecutor: boolean,
  tenant?: TenantContext,
  terminalUserId?: string,
  terminalId?: string,
  terminalBranchId?: string,
  terminalOwnerBootId?: string
): SocketAuthState {
  const state: SocketAuthState = { userId, isService };
  if (isTaskExecutor) state.isTaskExecutor = true;
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
 * Recognized states (checked in this order):
 *   1. Service (post-connect auth, canonical):
 *        feathers.user?._isServiceAccount === true
 *        — executor's client.authenticate({strategy:'jwt',...}) path.
 *        ServiceJWTStrategy attaches a synthetic user with this flag.
 *   2. Service (handshake fast-path):
 *        socket.data.isService === true
 *        — socket presented a service token on connect; middleware tagged it.
 *   3. User-authenticated:
 *        feathers.user?.user_id set and NOT a service account.
 *   4. Anonymous: none of the above.
 *
 * The service-account check is deliberately BEFORE the user-id check: the
 * synthetic service user carries `user_id: 'executor-service'`, but we do not
 * want to treat that as a real user for `terminal:input`/`resize` gating.
 *
 * Exported for unit tests and for handler authorization checks.
 */
export function getSocketAuthState(socket: Socket): SocketAuthState {
  const s = socket as FeathersSocket;
  const user = s.feathers?.user;
  if (isExecutorSessionTokenPayload(s.feathers?.authentication?.payload)) {
    return socketAuthState(null, false, true, s.data?.tenant);
  }
  // Terminal-scoped executor identity: a service identity for TERMINAL socket
  // auth only (join/output/etc.), NOT a full RBAC-bypassing service account.
  // Checked first and never carries `isService` privilege onto REST paths —
  // those read `user._isServiceAccount`, which this identity lacks by design.
  const terminalUserId = user?.terminal_user_id ?? s.data?.terminalUserId;
  if (typeof terminalUserId === 'string' && terminalUserId) {
    return socketAuthState(
      null,
      true,
      false,
      s.data?.tenant,
      terminalUserId,
      user?.terminal_id ?? s.data?.terminalId,
      user?.terminal_branch_id ?? s.data?.terminalBranchId,
      user?.terminal_owner_boot_id ?? s.data?.terminalOwnerBootId
    );
  }
  if (user?._isServiceAccount === true) {
    return socketAuthState(null, true, false, s.data?.tenant);
  }
  if (s.data?.isService === true) {
    return socketAuthState(null, true, false, s.data?.tenant);
  }
  if (user?.user_id) {
    return socketAuthState(user.user_id, false, false, s.data?.tenant);
  }
  return socketAuthState(null, false, false, s.data?.tenant);
}

/**
 * Convenience predicate — prefer this over duplicating the
 * `userId || isService` pattern at call sites.
 */
function isAuthenticated(auth: SocketAuthState): boolean {
  return auth.userId !== null || auth.isService || auth.isTaskExecutor === true;
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

type SocketJwtPayload = jwt.JwtPayload & {
  sub: string;
  type?: string;
  purpose?: string;
  role?: string;
  tenant_id?: string;
  terminal_user_id?: string;
  terminal_id?: string;
  terminal_branch_id?: string;
  terminal_owner_boot_id?: string;
};

/**
 * WebSocket tenant binding is derived from signed claims only. In particular,
 * a configured trusted HTTP tenant header is not trusted on an end-user
 * Socket.IO handshake: unlike the HTTP reverse-proxy boundary it arrives
 * directly from the client. Agor runtime tokens always carry tenant_id even
 * when the HTTP deployment uses a differently named claim/header.
 */
function resolveSignedSocketTenant(
  config: ResolvedMultiTenancyConfig | undefined,
  payload: SocketJwtPayload
): TenantContext | undefined {
  if (!config) return undefined;
  if (config.mode === 'required_from_auth') {
    const configuredClaim = config.auth_claim;
    const configuredValue =
      configuredClaim && typeof payload[configuredClaim] === 'string'
        ? payload[configuredClaim].trim()
        : undefined;
    const canonicalValue =
      typeof payload.tenant_id === 'string' ? payload.tenant_id.trim() : undefined;
    if (configuredValue && canonicalValue && configuredValue !== canonicalValue) {
      throw new Error('Conflicting signed tenant claims');
    }
    return resolveTenantContext(
      {
        ...config,
        auth_claim: configuredValue ? configuredClaim : 'tenant_id',
        trusted_header: undefined,
      },
      { authPayload: payload }
    );
  }
  return resolveTenantContext(config, { authPayload: payload });
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
  const { corsOrigin, jwtSecret, credentialsAllowed, buildInfo } = options;
  const multiTenancy = options.multiTenancy;
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
    let unauthenticatedDisconnects = 0;
    // Weak per-socket state owns both auth-log dedupe and durable auth history.
    const authenticatedIdentities = new WeakMap<Socket, string>();
    // Revokes captured terminal-subscription functions across logout and live
    // authentication replacement, even when the transport stays connected.
    const terminalAuthGenerations = new WeakMap<Socket, number>();
    const authExpiryGenerations = new WeakMap<Socket, number>();
    const authExpiryTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
    // Serialize subscription operations for one socket/channel. Socket.IO room
    // membership is a set, not reference-counted: overlapping join cleanup
    // must never remove another valid operation's membership.
    const terminalJoinQueues = new WeakMap<Socket, Map<string, Promise<void>>>();

    const clearSocketAuthExpiry = (socket: Socket): void => {
      authExpiryGenerations.set(socket, (authExpiryGenerations.get(socket) ?? 0) + 1);
      const timer = authExpiryTimers.get(socket);
      if (timer) clearTimeout(timer);
      authExpiryTimers.delete(socket);
    };

    const scheduleSocketAuthExpiry = (socket: Socket, payload: unknown): void => {
      clearSocketAuthExpiry(socket);
      const exp =
        payload &&
        typeof payload === 'object' &&
        typeof (payload as jwt.JwtPayload).exp === 'number'
          ? (payload as jwt.JwtPayload).exp
          : undefined;
      if (!exp || !Number.isFinite(exp)) return;
      const generation = authExpiryGenerations.get(socket) ?? 0;
      const expireAt = exp * 1000;
      const arm = (): void => {
        if ((authExpiryGenerations.get(socket) ?? 0) !== generation) return;
        const remaining = expireAt - Date.now();
        if (remaining <= 0) {
          // Socket.IO authenticates once, while room membership is passive.
          // End the transport at JWT expiry so a stale socket cannot retain
          // tenant/user/session/task capabilities indefinitely.
          socket.disconnect(true);
          return;
        }
        const timer = setTimeout(arm, Math.min(remaining, 2_147_000_000));
        timer.unref?.();
        authExpiryTimers.set(socket, timer);
      };
      arm();
    };

    const invalidateTerminalRequestJoin = (socket: FeathersSocket): void => {
      terminalAuthGenerations.set(socket, (terminalAuthGenerations.get(socket) ?? 0) + 1);
      const connection = socket.feathers as TerminalRequestConnection | undefined;
      if (connection) Reflect.deleteProperty(connection, TERMINAL_REQUEST_JOIN_CHANNEL);
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
            // Authentication may have changed while this operation waited for
            // an earlier join. Revalidate before touching room membership.
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
      const identity = userId ? `user:${userId}` : 'service';
      if (authenticatedIdentities.get(socket) === identity) return;
      authenticatedIdentities.set(socket, identity);

      console.log(
        userId
          ? `socket authenticated: ${socket.id} user:${shortId(userId)}`
          : `socket authenticated: ${socket.id} service`
      );
    };

    // SECURITY: Add authentication middleware for WebSocket connections
    io.use(async (socket, next) => {
      try {
        // Extract authentication token from handshake
        // Clients can send token via:
        // 1. socket.io auth object: io('url', { auth: { token: 'xxx' } })
        // 2. Authorization header: io('url', { extraHeaders: { Authorization: 'Bearer xxx' } })
        const authToken =
          typeof socket.handshake.auth?.token === 'string'
            ? socket.handshake.auth.token
            : undefined;
        const headerToken = bearerTokenFromHeader(socket.handshake.headers?.authorization);
        if (authToken && headerToken && authToken !== headerToken) {
          return next(new Error('Conflicting authentication credentials'));
        }
        const token = authToken ?? headerToken;

        if (!token) {
          // Allow the socket to connect without auth so the client can run the
          // login flow (POST /authentication). Service-level hooks (requireAuth)
          // enforce authentication on every protected endpoint, so an
          // unauthenticated socket can't read or write anything until it
          // authenticates.
          return next();
        }

        // Verify JWT token
        const decoded = jwt.verify(token, jwtSecret, {
          issuer: RUNTIME_JWT_ISSUER,
          audience: RUNTIME_JWT_AUDIENCE,
        }) as SocketJwtPayload;

        // Allow user tokens and service tokens (used by executor)
        // - undefined/access: User tokens (SessionTokenService doesn't set type claim)
        // - service: Executor service tokens (for terminal streaming, git ops, etc.)
        const tokenType = decoded.type;
        if (tokenType !== undefined && tokenType !== 'access' && tokenType !== 'service') {
          return next(new Error('Invalid token type'));
        }

        const tenant = resolveSignedSocketTenant(multiTenancy, decoded);

        // Handle service tokens (used by executor for terminal streaming, git operations, etc.)
        if (tokenType === 'service') {
          if (
            decoded.sub !== 'executor-service' ||
            (decoded.purpose !== undefined && decoded.purpose !== 'executor-service')
          ) {
            return next(new Error('Invalid service token scope'));
          }
          // Service tokens don't have a user - they authenticate the executor process.
          // Mark as service connection for terminal:* authorization checks below.
          // We tag socket.data.isService so getSocketAuthState() can distinguish
          // a service socket (trusted, no user) from an anonymous socket that
          // simply hasn't authenticated yet (untrusted, no user).
          const fs = socket as FeathersSocket;
          const terminalUserId =
            typeof decoded.terminal_user_id === 'string' ? decoded.terminal_user_id : undefined;
          // Mirror ServiceJWTStrategy: a terminal-scoped token is a RESTRICTED
          // identity (no `_isServiceAccount`, no `role: 'service'`, so no RBAC
          // bypass on REST paths); a plain service token is a full service
          // account. See getSocketAuthState + service-jwt-strategy.ts.
          fs.feathers = {
            user: terminalUserId
              ? {
                  user_id: 'executor-service',
                  email: 'executor@agor.internal',
                  role: 'terminal-executor',
                  _isTerminalExecutor: true,
                  terminal_user_id: terminalUserId,
                  terminal_id: decoded.terminal_id,
                  terminal_branch_id: decoded.terminal_branch_id,
                  terminal_owner_boot_id: decoded.terminal_owner_boot_id,
                }
              : {
                  user_id: 'executor-service',
                  email: 'executor@agor.internal',
                  role: 'service',
                  _isServiceAccount: true,
                },
          };
          if (terminalUserId) {
            fs.data.terminalUserId = terminalUserId;
            fs.data.terminalId = decoded.terminal_id;
            fs.data.terminalBranchId = decoded.terminal_branch_id;
            fs.data.terminalOwnerBootId = decoded.terminal_owner_boot_id;
          } else {
            // Handshake fast-path marker ONLY for full service accounts — older
            // code that looks at socket.data.isService must not see a terminal
            // token as a full service account.
            fs.data.isService = true;
          }
          if (tenant) {
            (fs as FeathersSocket & { tenant?: TenantContext }).tenant = tenant;
            if (fs.data) fs.data.tenant = tenant;
          }
          logAuthenticated(socket);
          scheduleSocketAuthExpiry(socket, decoded);
          return next();
        }

        // Handle user access tokens - fetch user from database
        const user = await app.service('users').get(
          decoded.sub as import('@agor/core/types').UUID,
          {
            ...(tenant ? { tenant } : {}),
            authentication: { payload: decoded },
          } as never
        );
        assertUserTokenNotInvalidated(user, decoded);

        // Attach user to socket (FeathersJS convention)
        const fs = socket as FeathersSocket;
        fs.feathers = { user: tenant ? { ...user, tenant_id: tenant.tenant_id } : user };
        if (tenant) {
          (fs as FeathersSocket & { tenant?: TenantContext }).tenant = tenant;
          if (fs.data) fs.data.tenant = tenant;
        }

        logAuthenticated(socket, user.user_id);
        scheduleSocketAuthExpiry(socket, decoded);
        next();
      } catch (error) {
        console.error(`❌ WebSocket authentication failed for ${socket.id}:`, error);
        next(new Error('Invalid or expired authentication token'));
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

    const evictTenantSockets = (data: { tenantId?: unknown }): void => {
      if (
        typeof data?.tenantId !== 'string' ||
        data.tenantId.length === 0 ||
        data.tenantId.length > 128
      ) {
        return;
      }
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
    app.on('realtime:authorization-invalidated', (data: { tenantId?: unknown }) => {
      evictTenantSockets(data);
      if (options.adapter) {
        io.serverSideEmit(HA_AUTHORIZATION_INVALIDATION_EVENT, data);
      }
    });
    io.on(HA_AUTHORIZATION_INVALIDATION_EVENT, evictTenantSockets);

    // Configure Socket.io for cursor presence events
    io.on('connection', (socket) => {
      activeConnections++;
      const feathersSocket = socket as FeathersSocket;
      bindTerminalRequestJoin(feathersSocket);
      const user = feathersSocket.feathers?.user;
      console.debug(
        `🔌 Socket.io connection established: ${socket.id} (auth: ${user ? 'handshake' : 'anonymous'}, user: ${user ? shortId(user.user_id) : 'unknown'}, total: ${activeConnections})`
      );

      // Welcome event: ship the daemon's build identity so UI tabs can spot
      // FE/BE drift after a deploy without waiting for the next /health poll.
      // Emitted BEFORE auth so even login-page tabs (which connect anonymously)
      // get a baseline SHA on first connect. The UI is the source of truth for
      // dev-mode short-circuit; we always send what we have.
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

      // Auto-join per-user room for user-scoped events (OAuth prompts, notifications)
      // Try at connection time (for sockets that authenticate via handshake token).
      // Terminal-executor identities are excluded from ALL room/channel joins —
      // they only ever consume raw `terminal:*` events on their own
      // tenant/user/terminal-qualified room, never Feathers channel broadcasts, so channel
      // membership would just hand them a firehose subscription they must not have.
      if (user?.user_id && user._isServiceAccount !== true && !isTerminalExecutorIdentity(user)) {
        const tenantId = (socket as FeathersSocket).data.tenant?.tenant_id;
        if (tenantId) {
          socket.join(tenantChannelName(tenantId));
          socket.join(tenantUserChannelName(tenantId, user.user_id));
        }
        console.debug(
          `🏠 Socket ${socket.id} joined user room at connection: user:${shortId(user.user_id)}`
        );
      }

      // Helper to get user ID from socket's Feathers connection
      const getUserId = () => {
        // In FeathersJS, the authenticated user is stored in socket.feathers
        const user = (socket as FeathersSocket).feathers?.user;
        return user?.user_id || 'unknown';
      };

      // A terminal-executor identity has zero non-terminal daemon visibility:
      // it must not watch board presence rooms or emit/receive cursor+presence
      // activity (it would otherwise spoof presence and observe collaborators).
      // Presence/cursor events run outside Feathers hooks, so they're guarded
      // here directly, consistent with the channel-join exclusions.
      const isTerminalExecutorSocket = () =>
        isTerminalExecutorIdentity((socket as FeathersSocket).feathers?.user);
      const getTenantId = () => getSocketAuthState(socket).tenant?.tenant_id;

      socket.on(
        'presence:watch-board',
        async (boardId: string, acknowledge?: (result: { ok: boolean }) => void) => {
          const auth = getSocketAuthState(socket);
          if (!auth.userId || isTerminalExecutorSocket()) return acknowledge?.({ ok: false });
          if (typeof boardId !== 'string' || !boardId.trim()) return acknowledge?.({ ok: false });
          if (!auth.tenant?.tenant_id) return acknowledge?.({ ok: false });
          const fs = socket as FeathersSocket;
          try {
            // Raw Socket.IO rooms bypass Feathers publication hooks, so perform
            // the normal authenticated boards.get authorization before granting
            // membership. Tenant-qualified room names alone are not branch/board
            // authorization and Redis prefixes are never treated as auth.
            await app.service('boards').get(boardId, {
              ...(fs.feathers ?? {}),
              provider: 'socketio',
              connection: fs.feathers,
              tenant: auth.tenant,
            } as never);
          } catch {
            return acknowledge?.({ ok: false });
          }

          // Authorization above is asynchronous. Logout or a second login can
          // replace this socket's identity while boards.get is in flight. Do
          // not let the stale completion restore a previous tenant's raw room
          // after the auth-replacement cleanup has already run.
          const currentAuth = getSocketAuthState(socket);
          if (
            !socket.connected ||
            currentAuth.userId !== auth.userId ||
            currentAuth.tenant?.tenant_id !== auth.tenant.tenant_id
          ) {
            return acknowledge?.({ ok: false });
          }
          fs.data.authorizedBoardIds ??= new Set();
          fs.data.authorizedBoardIds.add(boardId);
          socket.join(boardPresenceRoomName(auth.tenant.tenant_id, boardId));
          acknowledge?.({ ok: true });
        }
      );

      socket.on('presence:unwatch-board', (boardId: string) => {
        if (typeof boardId !== 'string' || !boardId.trim()) return;
        const tenantId = getTenantId();
        if (!tenantId) return;
        socket.leave(boardPresenceRoomName(tenantId, boardId));
        (socket as FeathersSocket).data.authorizedBoardIds?.delete(boardId);
      });

      // Handle cursor movement events
      socket.on('cursor-move', (data: CursorMoveEvent) => {
        if (isTerminalExecutorSocket()) return;
        const userId = getUserId();
        const fs = socket as FeathersSocket;
        const tenantId = getTenantId();
        if (!tenantId || !getSocketAuthState(socket).userId) return;
        if (!fs.data.authorizedBoardIds?.has(data.boardId)) return;
        const previousBoardId = fs.data.currentBoardId;

        if (previousBoardId && previousBoardId !== data.boardId) {
          emitHaNativeSocketEvent(
            socket.broadcast.to(boardPresenceRoomName(tenantId, previousBoardId)),
            'cursor-left',
            {
              userId,
              boardId: previousBoardId,
              timestamp: Date.now(),
            }
          );
        }

        const broadcastData: CursorMovedEvent = {
          userId,
          boardId: data.boardId,
          x: data.x,
          y: data.y,
          timestamp: data.timestamp,
        };

        // Broadcast cursor position only to tabs actively watching this board.
        emitHaNativeSocketEvent(
          socket.broadcast.to(boardPresenceRoomName(tenantId, data.boardId)),
          'cursor-moved',
          broadcastData
        );

        fs.data.currentBoardId = data.boardId;

        const shouldEmitPresenceUpdate =
          previousBoardId !== data.boardId ||
          !fs.data.lastPresenceEmitAt ||
          data.timestamp - fs.data.lastPresenceEmitAt >= GLOBAL_PRESENCE_EMIT_INTERVAL_MS;

        if (shouldEmitPresenceUpdate) {
          const presenceData: PresenceUpdatedEvent = {
            userId,
            timestamp: data.timestamp,
          };
          emitHaNativeSocketEvent(
            socket.broadcast.to(tenantChannelName(tenantId)),
            'presence-updated',
            presenceData
          );
          fs.data.lastPresenceEmitAt = data.timestamp;
        }
      });

      // Handle cursor leave events (user navigates away from board)
      socket.on('cursor-leave', (data: CursorLeaveEvent) => {
        if (isTerminalExecutorSocket()) return;
        const userId = getUserId();
        const fs = socket as FeathersSocket;
        const tenantId = getTenantId();
        if (!tenantId || !getSocketAuthState(socket).userId) return;
        if (!fs.data.authorizedBoardIds?.has(data.boardId)) return;

        emitHaNativeSocketEvent(
          socket.broadcast.to(boardPresenceRoomName(tenantId, data.boardId)),
          'cursor-left',
          {
            userId,
            boardId: data.boardId,
            timestamp: Date.now(),
          }
        );

        if (fs.data.currentBoardId === data.boardId) {
          delete fs.data.currentBoardId;
        }
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
            `taskExecutor=${auth.isTaskExecutor === true} tenantBound=${!!auth.tenant} ` +
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
      // (output/exit/tab/ready/error). Requires a service socket whose token is
      // terminal-scoped (`terminalUserId`, bound at spawn time) AND whose scope
      // matches the payload userId. The scope is required unconditionally: the
      // only legitimate emitter of these events is the terminal executor, which
      // always carries it, so a generic/unscoped service token has no business
      // driving another user's terminal. Returns true when the event may
      // proceed.
      const requireServiceForOwnTerminal = (
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
          rejectTerminal(event, `only service tokens may emit ${event}`);
          return null;
        }
        if (typeof payloadUserId !== 'string' || !payloadUserId) {
          rejectTerminal(event, 'missing userId');
          return null;
        }
        if (!auth.terminalUserId) {
          rejectTerminal(event, 'service token is not scoped to a terminal user');
          return null;
        }
        if (auth.terminalUserId !== payloadUserId) {
          rejectTerminal(
            event,
            `service token scoped to ${shortId(auth.terminalUserId)}… may not act for ` +
              `${shortId(payloadUserId)}…`
          );
          return null;
        }
        if (
          typeof payloadTerminalId !== 'string' ||
          !payloadTerminalId ||
          auth.terminalId !== payloadTerminalId
        ) {
          rejectTerminal(event, 'service token is not scoped to this terminal instance');
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
          rejectTerminal(event, 'service token is not scoped to a terminal branch');
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
        // executor's service token is bound to a single user (`terminalUserId`)
        // and may only join THAT user's channel — not any user's. A service
        // token with no terminal scope has no business on a terminal channel at
        // all. User sockets may only join their own channel.
        if (auth.tenant?.tenant_id !== target.tenantId) {
          rejectTerminal('join', 'terminal channel tenant does not match authenticated tenant');
          return;
        }
        if (auth.isService) {
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
        } else if (auth.userId !== target.userId) {
          rejectTerminal(
            'join',
            `user ${auth.userId ? shortId(auth.userId) : 'unknown'}… tried to join another user's terminal channel`
          );
          return;
        }
        console.debug(`🖥️  Socket ${socket.id} joining its authorized terminal channel`);
        socket.join(channel);
        if (auth.isService && auth.terminalId === target.terminalId) {
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
        const auth = requireServiceForOwnTerminal(
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
          const auth = requireServiceForOwnTerminal('terminal:tab', data?.userId, data?.terminalId);
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
          const auth = requireServiceForOwnTerminal(
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
          if (!requireServiceForOwnTerminal('terminal:ready', data?.userId, data?.terminalId)) {
            return;
          }
          app.emit('terminal:ready', data);
        }
      );

      // Executor attach-failure ack. Same user-scoped service trust as ready.
      socket.on(
        'terminal:error',
        (data: { userId: string; terminalId: string; message?: string }) => {
          if (!requireServiceForOwnTerminal('terminal:error', data?.userId, data?.terminalId)) {
            return;
          }
          app.emit('terminal:error', data);
        }
      );

      // Track disconnections
      socket.on('disconnect', (reason) => {
        clearSocketAuthExpiry(socket);
        activeConnections--;
        const disconnectedBeforeAuthentication =
          !authenticatedIdentities.has(socket) && !isAuthenticated(getSocketAuthState(socket));
        if (disconnectedBeforeAuthentication) {
          unauthenticatedDisconnects = Math.min(
            unauthenticatedDisconnects + 1,
            Number.MAX_SAFE_INTEGER
          );
        }
        const message = `🔌 Socket.io disconnected: ${socket.id} (reason: ${reason}, remaining: ${activeConnections})`;
        if (reason === 'transport error') {
          console.warn(message);
        } else if (disconnectedBeforeAuthentication) {
          return;
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

    // Join user room after FeathersJS authentication completes
    // Sockets connect anonymously first, then authenticate via client.authenticate().
    // The io.on('connection') handler above only catches pre-authenticated sockets
    // (those with a handshake token). Most browser sockets authenticate AFTER connecting,
    // so we need to join the user room here when the login event fires.
    app.on('login', (authResult: unknown, context: { connection?: unknown; params?: unknown }) => {
      if (!context.connection) return;
      const result = authResult as {
        user?: { user_id?: string; _isServiceAccount?: boolean };
        authentication?: { payload?: unknown };
      };
      const userId = result.user?.user_id;
      if (!userId) return;

      // Find the socket whose feathers connection matches this login
      for (const [, socket] of io.sockets.sockets) {
        if ((socket as FeathersSocket).feathers === context.connection) {
          const fs = socket as FeathersSocket & { tenant?: TenantContext };
          // Revoke captured functions before any yields or room changes. A
          // replacement login may reuse the same transport/connection object.
          invalidateTerminalRequestJoin(fs);
          const isService =
            result.user?._isServiceAccount === true || isTerminalExecutorIdentity(result.user);
          const isTerminalExecutor = isTerminalExecutorIdentity(result.user);
          const authenticatedPayload =
            result.authentication?.payload ?? fs.feathers?.authentication?.payload;
          const isTaskExecutor = isExecutorSessionTokenPayload(authenticatedPayload);
          scheduleSocketAuthExpiry(socket, authenticatedPayload);
          logAuthenticated(socket, isService || isTaskExecutor ? undefined : userId);

          // Authentication can be replaced on a live transport. Revoke every
          // raw Socket.IO capability belonging to the previous identity before
          // deriving rooms for the new one. This must also run when the new
          // identity is a service/terminal executor; otherwise user -> service
          // replacement would retain the user's tenant and board subscriptions.
          for (const room of socket.rooms) {
            if (isTenantRealtimeRoomName(room) || parseTerminalChannel(room)) socket.leave(room);
          }
          fs.data.authorizedBoardIds?.clear();
          delete fs.data.currentBoardId;
          delete fs.data.tenant;
          delete fs.tenant;
          delete fs.data.isService;
          delete fs.data.terminalUserId;
          delete fs.data.terminalId;
          delete fs.data.terminalBranchId;
          delete fs.data.terminalOwnerBootId;

          // Resolve and retain trusted tenant context for both users and the
          // restricted terminal executor. The executor gets no generic user
          // rooms, but its terminal capability is tenant-qualified.
          let tenant: TenantContext | undefined;
          if (multiTenancy && (!isService || isTerminalExecutor || isTaskExecutor)) {
            try {
              tenant = resolveSignedSocketTenant(
                multiTenancy,
                authenticatedPayload as SocketJwtPayload
              );
              fs.data.tenant = tenant;
              fs.tenant = tenant;
            } catch {
              // configureChannels will fail closed as well; no raw room join.
            }
          }

          // Terminal-executor identities get no user room (see connection handler).
          if (!isService && !isTaskExecutor) {
            const tenantId = tenant?.tenant_id;
            if (tenantId) {
              socket.join(tenantChannelName(tenantId));
              socket.join(tenantUserChannelName(tenantId, userId));
            }
          }
          // Bind only after the replacement identity and tenant are installed.
          // Anonymous and service identities deliberately receive no terminal
          // request capability.
          bindTerminalRequestJoin(fs);
          break;
        }
      }
    });

    // Feathers channel removal does not affect raw Socket.IO rooms. Explicitly
    // drop every tenant-scoped direct room on logout so a connected anonymous
    // socket cannot keep receiving presence or user notifications.
    app.on('logout', (_authResult: unknown, context: { connection?: unknown }) => {
      if (!context.connection) return;
      for (const [, socket] of io.sockets.sockets) {
        if ((socket as FeathersSocket).feathers !== context.connection) continue;
        const fs = socket as FeathersSocket;
        clearSocketAuthExpiry(socket);
        invalidateTerminalRequestJoin(fs);
        for (const room of socket.rooms) {
          if (isTenantRealtimeRoomName(room) || parseTerminalChannel(room)) socket.leave(room);
        }
        fs.data.authorizedBoardIds?.clear();
        delete fs.data.currentBoardId;
        delete fs.data.tenant;
        delete (fs as FeathersSocket & { tenant?: TenantContext }).tenant;
        delete fs.data.isService;
        delete fs.data.terminalUserId;
        delete fs.data.terminalId;
        delete fs.data.terminalBranchId;
        delete fs.data.terminalOwnerBootId;
        break;
      }
    });

    // Emit a fixed-key gauge on a steady cadence so log collectors can parse it
    // and periods with no connection churn remain observable.
    const metricsInterval = setInterval(
      () => {
        const disconnectedBeforeAuthentication = unauthenticatedDisconnects;
        unauthenticatedDisconnects = 0;
        console.log(
          `ws_active_connections=${activeConnections} ws_unauthenticated_disconnects=${disconnectedBeforeAuthentication}`
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

/**
 * Configure FeathersJS channels for event broadcasting
 *
 * SECURITY: Only authenticated connections receive broadcast events.
 * Unauthenticated sockets can connect (for login flow) but won't receive
 * any service events until they successfully authenticate.
 *
 * Sets up:
 * - 'authenticated' channel for authenticated connections only
 * - Login event joins connection to authenticated channel
 * - Logout event removes connection from authenticated channel
 *
 * @param app - FeathersJS application instance
 */
export function configureChannels(
  app: Application,
  options: { multiTenancy?: ResolvedMultiTenancyConfig } = {}
): void {
  // SECURITY: Do NOT join connections to any channel on connect.
  // Unauthenticated sockets should not receive broadcast events.
  // They will be joined to 'authenticated' channel only after successful login.
  app.on('connection', (_connection: unknown) => {
    // Intentionally empty - connections start without channel membership
    // This prevents unauthenticated sockets from receiving service events
  });

  // Join authenticated connections to the 'authenticated' channel
  // This is the only way to receive broadcast events
  app.on('login', (authResult: unknown, context: { connection?: unknown; params?: unknown }) => {
    if (context.connection) {
      const result = authResult as {
        user?: { user_id?: string; email?: string; tenant_id?: string };
        authentication?: { payload?: unknown };
        task_id?: string;
      };
      // Authentication can be replaced on an already-open socket. Remove any
      // prior identity's complete Feathers capability set before considering
      // the new signed claims. Raw Socket.IO rooms are cleared by the sibling
      // login handler above; these named Feathers channels are independent.
      app.channel('authenticated').leave(context.connection as never);
      leaveAllTenantChannels(app, context.connection);
      leaveAllSessionStreamChannels(app, context.connection);
      leaveAllExecutorTaskChannels(app, context.connection);

      const connection = context.connection as FeathersSocket & { tenant?: TenantContext };
      delete connection.tenant;
      if (connection.data) delete connection.data.tenant;

      // A terminal-executor identity must NOT receive broadcast events. It only
      // consumes raw `terminal:*` events on its own qualified terminal room,
      // never Feathers channel broadcasts — joining `authenticated`/tenant
      // channels would give the long-lived terminal token a read-everything
      // subscription to the realtime firehose. Keyed on `_isTerminalExecutor`
      // specifically so full service accounts KEEP their channel membership.
      if (isTerminalExecutorIdentity(result.user)) return;

      let tenant: TenantContext | undefined;
      try {
        tenant = resolveSignedSocketTenant(
          options.multiTenancy,
          result.authentication?.payload as SocketJwtPayload
        );
      } catch {
        // Authentication succeeded but no trustworthy signed tenant was
        // available. Leave the connection in no publication channel.
        return;
      }
      if (tenant) {
        connection.tenant = tenant;
        if (connection.data) connection.data.tenant = tenant;
      }

      const executorPayload = result.authentication?.payload;
      if (isExecutorSessionTokenPayload(executorPayload)) {
        // A task executor is an authenticated, task-scoped control-plane
        // principal—not the session creator. It receives only its private task
        // room, never authenticated/tenant/user/stream publication channels.
        if (
          !tenant ||
          typeof executorPayload.task_id !== 'string' ||
          executorPayload.task_id.length === 0 ||
          result.task_id !== executorPayload.task_id
        ) {
          return;
        }
        joinExecutorTaskChannel(app, tenant.tenant_id, executorPayload.task_id, context.connection);
        console.debug(
          `🎯 Executor connection joined its task control room: ${shortId(executorPayload.task_id)}`
        );
        return;
      }

      // SECURITY: Only now does the connection receive broadcast events.
      app.channel('authenticated').join(context.connection as never);
      if (tenant) {
        app.channel(tenantChannelName(tenant.tenant_id)).join(context.connection as never);
        if (result.user?.user_id) {
          app
            .channel(tenantUserChannelName(tenant.tenant_id, result.user.user_id))
            .join(context.connection as never);
        }
      }
    }
  });

  // Remove connection from authenticated channel on logout
  app.on('logout', (_authResult: unknown, context: { connection?: unknown }) => {
    if (context.connection) {
      console.log('👋 Logout event fired');

      const connection = context.connection as FeathersSocket & { tenant?: TenantContext };

      // Remove from authenticated channel - no more broadcast events
      app.channel('authenticated').leave(context.connection as never);
      leaveAllExecutorTaskChannels(app, context.connection);
      leaveAllTenantChannels(app, context.connection);
      // Streaming rooms are separate per-session channels; drop the logged-out
      // connection from all of them so it stops receiving live session text
      // while it remains socket-connected.
      leaveAllSessionStreamChannels(app, context.connection);
      delete connection.tenant;
      if (connection.data) delete connection.data.tenant;
    }
  });
}
