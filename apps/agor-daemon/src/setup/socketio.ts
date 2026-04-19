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
 * that user's web terminal channel — which under unix_user_mode=strict is
 * full impersonation of the victim's OS identity, and under simple mode is a
 * shell as the daemon user (with read access to ~/.agor/config.yaml,
 * agor.db, and the JWT secret). See `terminal:*` handlers below.
 */

import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedUser,
  CursorLeaveEvent,
  CursorMovedEvent,
  CursorMoveEvent,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';
import type { Server, Socket } from 'socket.io';
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
 * every other daemon authz path (worktree-authorization.ts, register-hooks.ts,
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
  };
  data: {
    isService?: boolean;
  };
}

export interface SocketIOOptions {
  /** CORS origin configuration */
  corsOrigin: CorsOrigin;
  /** JWT secret for token verification */
  jwtSecret: string;
  /** Whether anonymous access is allowed */
  allowAnonymous: boolean;
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
   * (and joins to `user/*\/terminal` channels) are rejected at the socket
   * layer. This matches the HTTP terminals service gate in register-hooks.ts
   * and keeps the kill-switch effective for both transports. Defaults to
   * true if omitted.
   */
  webTerminalEnabled?: boolean;
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
  if (user?._isServiceAccount === true) {
    return { userId: null, isService: true };
  }
  if (s.data?.isService === true) {
    return { userId: null, isService: true };
  }
  if (user?.user_id) {
    return { userId: user.user_id, isService: false };
  }
  return { userId: null, isService: false };
}

/**
 * Convenience predicate — prefer this over duplicating the
 * `userId || isService` pattern at call sites.
 */
function isAuthenticated(auth: SocketAuthState): boolean {
  return auth.userId !== null || auth.isService;
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

/**
 * Validate a terminal channel name and extract its target user_id.
 *
 * Channel format: `user/<uuid>/terminal`. Returns null on bad shape.
 * Exported for tests.
 */
export function parseTerminalChannel(channel: string): string | null {
  if (typeof channel !== 'string') return null;
  if (!channel.startsWith('user/') || !channel.endsWith('/terminal')) return null;
  const inner = channel.slice('user/'.length, channel.length - '/terminal'.length);
  // Reject empty / nested-slash channels — `user//terminal` or
  // `user/foo/bar/terminal` must not parse as a valid terminal channel.
  if (!inner || inner.includes('/')) return null;
  return inner;
}

export interface SocketIOResult {
  /** Socket.io server instance (for graceful shutdown) */
  socketServer: Server | null;
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
  const { corsOrigin, jwtSecret, allowAnonymous, credentialsAllowed } = options;
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
    maxHttpBufferSize: 1e6, // 1MB max message size
    transports: ['websocket', 'polling'], // Prefer WebSocket
  };

  const callback = (io: Server) => {
    // Store Socket.io server instance for shutdown
    socketServer = io;

    // Track active connections for debugging
    let activeConnections = 0;
    let lastLoggedCount = 0;

    // SECURITY: Add authentication middleware for WebSocket connections
    io.use(async (socket, next) => {
      try {
        // Extract authentication token from handshake
        // Clients can send token via:
        // 1. socket.io auth object: io('url', { auth: { token: 'xxx' } })
        // 2. Authorization header: io('url', { extraHeaders: { Authorization: 'Bearer xxx' } })
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.replace('Bearer ', '');

        if (!token) {
          // SECURITY: Always allow unauthenticated socket connections
          // This is required for the login flow to work (client needs to connect before authenticating)
          // Service-level hooks (requireAuth) will enforce authentication for protected endpoints
          // The /authentication endpoint explicitly allows unauthenticated access for login
          if (allowAnonymous) {
            console.log(`🔓 WebSocket connection without auth (anonymous allowed): ${socket.id}`);
          } else {
            console.log(`🔓 WebSocket connection without auth (for login flow): ${socket.id}`);
          }
          // Don't set socket.feathers.user - will be handled by FeathersJS auth
          return next();
        }

        // Verify JWT token
        const decoded = jwt.verify(token, jwtSecret, {
          issuer: 'agor',
          audience: 'https://agor.dev',
        }) as { sub: string; type?: string; role?: string };

        // Allow user tokens and service tokens (used by executor)
        // - undefined/access: User tokens (SessionTokenService doesn't set type claim)
        // - service: Executor service tokens (for terminal streaming, git ops, etc.)
        const tokenType = decoded.type;
        if (tokenType !== undefined && tokenType !== 'access' && tokenType !== 'service') {
          return next(new Error('Invalid token type'));
        }

        // Handle service tokens (used by executor for terminal streaming, git operations, etc.)
        if (tokenType === 'service') {
          // Service tokens don't have a user - they authenticate the executor process.
          // Mark as service connection for terminal:* authorization checks below.
          // We tag socket.data.isService so getSocketAuthState() can distinguish
          // a service socket (trusted, no user) from an anonymous socket that
          // simply hasn't authenticated yet (untrusted, no user).
          const fs = socket as FeathersSocket;
          // Attach synthetic service user so getSocketAuthState returns
          // isService=true via the canonical `_isServiceAccount` path. This
          // mirrors what ServiceJWTStrategy.getEntity does on the Feathers
          // side for sockets that authenticate post-connect.
          fs.feathers = {
            user: {
              user_id: 'executor-service',
              email: 'executor@agor.internal',
              role: 'service',
              _isServiceAccount: true,
            },
          };
          // Keep the handshake fast-path marker too — older code and any
          // future callers that only look at socket.data still see it.
          fs.data.isService = true;
          console.log(
            `🔐 WebSocket authenticated (service): ${socket.id} (role: ${decoded.role || 'unknown'})`
          );
          return next();
        }

        // Handle user access tokens - fetch user from database
        const user = await app.service('users').get(decoded.sub as import('@agor/core/types').UUID);

        // Attach user to socket (FeathersJS convention)
        (socket as FeathersSocket).feathers = { user };

        console.log(
          `🔐 WebSocket authenticated: ${socket.id} (user: ${user.user_id.substring(0, 8)})`
        );
        next();
      } catch (error) {
        console.error(`❌ WebSocket authentication failed for ${socket.id}:`, error);
        next(new Error('Invalid or expired authentication token'));
      }
    });

    // Configure Socket.io for cursor presence events
    io.on('connection', (socket) => {
      activeConnections++;
      const user = (socket as FeathersSocket).feathers?.user;
      console.log(
        `🔌 Socket.io connection established: ${socket.id} (user: ${user ? user.user_id.substring(0, 8) : 'anonymous'}, total: ${activeConnections})`
      );

      // Auto-join per-user room for user-scoped events (OAuth prompts, notifications)
      // Try at connection time (for sockets that authenticate via handshake token)
      if (user?.user_id) {
        socket.join(`user:${user.user_id}`);
        console.log(
          `🏠 Socket ${socket.id} joined user room at connection: user:${user.user_id.substring(0, 8)}`
        );
      }

      // Log connection lifespan after 5 seconds to identify long-lived connections
      setTimeout(() => {
        if (socket.connected) {
          console.log(
            `⏱️  Socket ${socket.id} still connected after 5s (likely persistent connection)`
          );
        }
      }, 5000);

      // Helper to get user ID from socket's Feathers connection
      const getUserId = () => {
        // In FeathersJS, the authenticated user is stored in socket.feathers
        const user = (socket as FeathersSocket).feathers?.user;
        return user?.user_id || 'anonymous';
      };

      // Handle cursor movement events
      socket.on('cursor-move', (data: CursorMoveEvent) => {
        const userId = getUserId();

        // Broadcast cursor position to all users on the same board except sender
        const broadcastData: CursorMovedEvent = {
          userId,
          boardId: data.boardId,
          x: data.x,
          y: data.y,
          timestamp: data.timestamp,
        };

        socket.broadcast.emit('cursor-moved', broadcastData);
      });

      // Handle cursor leave events (user navigates away from board)
      socket.on('cursor-leave', (data: CursorLeaveEvent) => {
        const userId = getUserId();

        socket.broadcast.emit('cursor-left', {
          userId,
          boardId: data.boardId,
          timestamp: Date.now(),
        });
      });

      // =========================================================================
      // TERMINAL CHANNEL SUPPORT
      //
      // Executors and browsers join `user/<userId>/terminal` channels and
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
      //                          enforcing worktree RBAC at the HTTP layer;
      //                          server-side emits never hit this handler.)
      //
      //   join / leave:
      //     - require user auth
      //     - channel MUST be `user/<self>/terminal` (or any user/*/terminal
      //       for service sockets). This stops a member from joining another
      //       user's terminal channel and harvesting their PTY output.
      //
      //   Worktree RBAC for opening a terminal against a specific worktree
      //   is enforced at the HTTP `terminals.create({ worktreeId })` entry
      //   point (see services/terminals.ts ~L194). Browsers cannot bypass
      //   that gate from the WS side, because creating a Zellij tab in an
      //   arbitrary worktree requires terminal:tab — and only service-token
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
        console.warn(
          `🚫 ${event} rejected on socket ${socket.id}: ${reason} ` +
            `(authState=${JSON.stringify(getSocketAuthState(socket))})`
        );
      };

      // Common preflight for browser-emitted terminal events. Returns the
      // authenticated user's id when the event should proceed, or null when
      // the event was rejected (and the caller must return).
      const requireUserForOwnUserId = (
        event: 'terminal:input' | 'terminal:resize',
        payloadUserId: unknown
      ): string | null => {
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
            `payload userId (${String(payloadUserId).slice(0, 8)}…) does not match ` +
              `authed userId (${auth.userId.slice(0, 8)}…)`
          );
          return null;
        }
        return auth.userId;
      };

      // Handle explicit channel joins (for terminal channels)
      socket.on('join', (channel: string) => {
        if (!webTerminalEnabled) {
          rejectTerminal('join', 'web terminal disabled (allow_web_terminal=false)');
          return;
        }
        const target = parseTerminalChannel(channel);
        if (!target) {
          console.warn(`⚠️  Socket ${socket.id} tried to join invalid channel: ${channel}`);
          return;
        }
        const auth = getSocketAuthState(socket);
        if (!isAuthenticated(auth)) {
          rejectTerminal('join', `unauthenticated socket cannot join ${channel}`);
          return;
        }
        // Service sockets (executor) are allowed to join any user's terminal
        // channel — that's how they relay PTY I/O for the user they're
        // proxying. User sockets may only join their OWN channel.
        if (!auth.isService && auth.userId !== target) {
          rejectTerminal(
            'join',
            `user ${auth.userId?.slice(0, 8)}… tried to join ${target.slice(0, 8)}…'s channel`
          );
          return;
        }
        console.log(`🖥️  Socket ${socket.id} joining terminal channel: ${channel}`);
        socket.join(channel);
      });

      // Handle explicit channel leaves. Same auth model as join: service
      // sockets can leave any channel, users can only leave their own. We
      // also reject for unauthenticated sockets to prevent noise / probing.
      socket.on('leave', (channel: string) => {
        const target = parseTerminalChannel(channel);
        if (target) {
          const auth = getSocketAuthState(socket);
          if (!isAuthenticated(auth)) {
            rejectTerminal('leave', `unauthenticated socket cannot leave ${channel}`);
            return;
          }
          if (!auth.isService && auth.userId !== target) {
            rejectTerminal(
              'leave',
              `user ${auth.userId?.slice(0, 8)}… tried to leave ${target.slice(0, 8)}…'s channel`
            );
            return;
          }
        }
        console.log(`🖥️  Socket ${socket.id} leaving channel: ${channel}`);
        socket.leave(channel);
      });

      // Route terminal output from executor to browser.
      // Executor emits: terminal:output { userId, data } → broadcast to channel
      // ONLY service sockets may emit this — otherwise a member could spoof
      // arbitrary output (e.g. fake "permission granted" prompts) into
      // another user's terminal.
      socket.on('terminal:output', (data: { userId: string; data: string }) => {
        if (!webTerminalEnabled) {
          rejectTerminal('terminal:output', 'web terminal disabled');
          return;
        }
        const auth = getSocketAuthState(socket);
        if (!auth.isService) {
          rejectTerminal('terminal:output', 'only service tokens may emit terminal:output');
          return;
        }
        if (typeof data?.userId !== 'string' || !data.userId) {
          rejectTerminal('terminal:output', 'missing userId');
          return;
        }
        const channel = `user/${data.userId}/terminal`;
        io.to(channel).emit('terminal:output', data);
      });

      // Route terminal input from browser to executor.
      // Browser emits: terminal:input { userId, input } → broadcast to channel
      // Auth: must be the authenticated user, and payload.userId MUST match.
      socket.on('terminal:input', (data: { userId: string; input: string }) => {
        const userId = requireUserForOwnUserId('terminal:input', data?.userId);
        if (!userId) return;
        if (!inputRateLimit()) {
          rejectTerminal('terminal:input', 'rate limit exceeded (>500/s)');
          return;
        }
        // Re-derive the channel and userId from the AUTHENTICATED identity.
        // Even though we already validated payload.userId matches authed
        // userId above, we send the trusted value downstream so executors
        // never see attacker-controlled strings even if the check above is
        // ever weakened.
        const channel = `user/${userId}/terminal`;
        io.to(channel).emit('terminal:input', { userId, input: data.input });
      });

      // Route terminal resize events. Same auth model as terminal:input —
      // browser-emitted, must match authed user. Resize events aren't a
      // direct shell-injection vector but a hijacker could use them to
      // disrupt the victim's session, so we lock them down anyway.
      socket.on('terminal:resize', (data: { userId: string; cols: number; rows: number }) => {
        const userId = requireUserForOwnUserId('terminal:resize', data?.userId);
        if (!userId) return;
        const channel = `user/${userId}/terminal`;
        io.to(channel).emit('terminal:resize', { userId, cols: data.cols, rows: data.rows });
      });

      // Route terminal tab commands. The daemon emits this server-side via
      // io.to() (terminals.ts) AFTER enforcing worktree RBAC on the HTTP
      // create() path. We must NOT let browsers emit it directly — doing so
      // would let a user with 'view'-only on a worktree open a Zellij tab
      // (and a shell) inside that worktree, bypassing the HTTP RBAC gate.
      socket.on(
        'terminal:tab',
        (data: { userId: string; action: string; tabName: string; cwd?: string }) => {
          if (!webTerminalEnabled) {
            rejectTerminal('terminal:tab', 'web terminal disabled');
            return;
          }
          const auth = getSocketAuthState(socket);
          if (!auth.isService) {
            rejectTerminal(
              'terminal:tab',
              'only service tokens may emit terminal:tab (browsers must use HTTP terminals.create)'
            );
            return;
          }
          if (typeof data?.userId !== 'string' || !data.userId) {
            rejectTerminal('terminal:tab', 'missing userId');
            return;
          }
          const channel = `user/${data.userId}/terminal`;
          io.to(channel).emit('terminal:tab', data);
        }
      );

      // Handle terminal exit notification from executor.
      // Executor-only — a forged exit would let a member terminate or
      // confuse another user's terminal session.
      socket.on('terminal:exit', (data: { userId: string; exitCode: number; signal?: number }) => {
        if (!webTerminalEnabled) {
          rejectTerminal('terminal:exit', 'web terminal disabled');
          return;
        }
        const auth = getSocketAuthState(socket);
        if (!auth.isService) {
          rejectTerminal('terminal:exit', 'only service tokens may emit terminal:exit');
          return;
        }
        if (typeof data?.userId !== 'string' || !data.userId) {
          rejectTerminal('terminal:exit', 'missing userId');
          return;
        }
        const channel = `user/${data.userId}/terminal`;
        io.to(channel).emit('terminal:exit', data);
        console.log(`🖥️  Terminal exited for user ${data.userId}: code=${data.exitCode}`);
      });

      // Track disconnections
      socket.on('disconnect', (reason) => {
        activeConnections--;
        console.log(
          `🔌 Socket.io disconnected: ${socket.id} (reason: ${reason}, remaining: ${activeConnections})`
        );
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
    app.on('login', (authResult: unknown, context: { connection?: unknown }) => {
      if (!context.connection) return;
      const result = authResult as { user?: { user_id?: string } };
      const userId = result.user?.user_id;
      if (!userId) return;

      // Find the socket whose feathers connection matches this login
      for (const [, socket] of io.sockets.sockets) {
        if ((socket as FeathersSocket).feathers === context.connection) {
          socket.join(`user:${userId}`);
          console.log(
            `🏠 Socket ${socket.id} joined user room after login: user:${userId.substring(0, 8)}`
          );
          break;
        }
      }
    });

    // Log connection metrics only when count changes (every 30 seconds)
    // FIX: Store interval handle to prevent memory leak
    const metricsInterval = setInterval(() => {
      if (activeConnections !== lastLoggedCount) {
        console.log(`📊 Active WebSocket connections: ${activeConnections}`);
        lastLoggedCount = activeConnections;
      }
    }, 30000);

    // Ensure interval is cleared on shutdown
    process.once('beforeExit', () => clearInterval(metricsInterval));
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
export function configureChannels(app: Application): void {
  // SECURITY: Do NOT join connections to any channel on connect.
  // Unauthenticated sockets should not receive broadcast events.
  // They will be joined to 'authenticated' channel only after successful login.
  app.on('connection', (_connection: unknown) => {
    // Intentionally empty - connections start without channel membership
    // This prevents unauthenticated sockets from receiving service events
  });

  // Join authenticated connections to the 'authenticated' channel
  // This is the only way to receive broadcast events
  app.on('login', (authResult: unknown, context: { connection?: unknown }) => {
    if (context.connection) {
      const result = authResult as { user?: { user_id?: string; email?: string } };
      console.log('✅ Login event fired:', result.user?.user_id, result.user?.email);

      // SECURITY: Only now does the connection receive broadcast events
      app.channel('authenticated').join(context.connection as never);
    }
  });

  // Remove connection from authenticated channel on logout
  app.on('logout', (_authResult: unknown, context: { connection?: unknown }) => {
    if (context.connection) {
      console.log('👋 Logout event fired');

      // Remove from authenticated channel - no more broadcast events
      app.channel('authenticated').leave(context.connection as never);
    }
  });
}
