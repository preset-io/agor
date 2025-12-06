/**
 * Socket.io Configuration
 *
 * Configures WebSocket server with authentication middleware,
 * cursor presence tracking, and connection management.
 */

import type { Application } from '@agor/core/feathers';
import type { CursorLeaveEvent, CursorMovedEvent, CursorMoveEvent, User } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import type { Server, Socket } from 'socket.io';
import type { CorsOrigin } from './cors.js';

/**
 * FeathersJS extends Socket.io socket with authentication context
 */
interface FeathersSocket extends Socket {
  feathers?: {
    user?: User;
  };
}

export interface SocketIOOptions {
  /** CORS origin configuration */
  corsOrigin: CorsOrigin;
  /** JWT secret for token verification */
  jwtSecret: string;
  /** Whether anonymous access is allowed */
  allowAnonymous: boolean;
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
  const { corsOrigin, jwtSecret, allowAnonymous } = options;

  let socketServer: Server | null = null;

  const serverOptions = {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      credentials: true,
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
        }) as { sub: string; type: string };

        if (decoded.type !== 'access') {
          return next(new Error('Invalid token type'));
        }

        // Fetch user from database
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
