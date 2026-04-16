/**
 * Startup & Shutdown
 *
 * Orchestrates post-boot steps: orphan cleanup, health monitor, master secret,
 * server listen, scheduler, gateway init, and graceful shutdown.
 */

import type { AgorConfig } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type { Id, Paginated, Session, Task } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import type { Application, SessionsServiceImpl, TasksServiceImpl } from './declarations.js';
import type { GatewayService } from './services/gateway.js';
import { createHealthMonitor } from './services/health-monitor.js';
import { SchedulerService } from './services/scheduler.js';
import type { TerminalsService } from './services/terminals.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface StartupContext {
  app: Application;
  db: Database;
  config: AgorConfig;
  DAEMON_PORT: number;
  /** Bind address (default: 'localhost', use '0.0.0.0' for containers) */
  DAEMON_HOST: string;
  svcEnabled: (group: string) => boolean;
  /** Safe service getter — returns undefined if service is not registered */
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service return type varies by path
  safeService: (path: string) => any;
  /** Socket.io getSocketServer accessor for graceful shutdown */
  getSocketServer: () => import('socket.io').Server | null;
  /** Services returned from registerServices() */
  sessionsService: SessionsServiceImpl;
  terminalsService: TerminalsService | null;
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

async function cleanupOrphans(ctx: StartupContext): Promise<void> {
  const { app, sessionsService } = ctx;

  // Get tasks service from the app (registered during services phase)
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;

  console.log('🧹 Cleaning up orphaned tasks and sessions...');

  // Find all orphaned tasks (running, stopping, awaiting_permission)
  const orphanedTasks = await tasksService.getOrphaned();

  if (orphanedTasks.length > 0) {
    console.log(`   Found ${orphanedTasks.length} orphaned task(s)`);
    for (const task of orphanedTasks) {
      await tasksService.patch(task.task_id, {
        status: TaskStatus.STOPPED,
      });
      console.log(`   ✓ Marked task ${task.task_id} as stopped (was: ${task.status})`);
    }
  }

  // Find all orphaned sessions (RUNNING, STOPPING, AWAITING_PERMISSION, AWAITING_INPUT, TIMED_OUT)
  const orphanedSessions: Session[] = [];
  for (const status of [
    SessionStatus.RUNNING,
    SessionStatus.STOPPING,
    SessionStatus.AWAITING_PERMISSION,
    SessionStatus.AWAITING_INPUT,
    SessionStatus.TIMED_OUT,
  ]) {
    const result = (await sessionsService.find({
      query: { status, $limit: 1000 },
    })) as unknown as Paginated<Session>;
    orphanedSessions.push(...result.data);
  }

  if (orphanedSessions.length > 0) {
    console.log(`   Found ${orphanedSessions.length} orphaned session(s)`);
    for (const session of orphanedSessions) {
      // IMPORTANT: Use app.service() instead of sessionsService to go through
      // FeathersJS service layer and trigger app.publish() for WebSocket events
      await app.service('sessions').patch(
        session.session_id,
        {
          status: SessionStatus.IDLE,
          ready_for_prompt: true,
        },
        {}
      );
      console.log(
        `   ✓ Marked session ${session.session_id.substring(0, 8)} as idle (was: ${session.status})`
      );
    }
  }

  // Also check for sessions that had orphaned tasks (even if session wasn't in RUNNING/STOPPING)
  const sessionIdsWithOrphanedTasks = new Set(
    orphanedTasks.map((t: Task) => t.session_id as string)
  );
  if (sessionIdsWithOrphanedTasks.size > 0) {
    console.log(
      `   Checking ${sessionIdsWithOrphanedTasks.size} session(s) with orphaned tasks...`
    );
    for (const sessionId of sessionIdsWithOrphanedTasks) {
      const session = await sessionsService.get(sessionId as Id);
      // If session is still in an active state after orphaned task cleanup, set to IDLE
      if (
        session.status === SessionStatus.RUNNING ||
        session.status === SessionStatus.STOPPING ||
        session.status === SessionStatus.AWAITING_PERMISSION ||
        session.status === SessionStatus.TIMED_OUT
      ) {
        await app.service('sessions').patch(
          sessionId as Id,
          {
            status: SessionStatus.IDLE,
            ready_for_prompt: true,
          },
          {}
        );
        console.log(
          `   ✓ Marked session ${sessionId.substring(0, 8)} as idle (had orphaned tasks, was: ${session.status})`
        );
      }
    }
  }

  if (orphanedTasks.length === 0 && orphanedSessions.length === 0) {
    console.log('   No orphaned tasks or sessions found');
  }
}

// ---------------------------------------------------------------------------
// Master secret
// ---------------------------------------------------------------------------

async function ensureMasterSecret(config: AgorConfig): Promise<void> {
  if (!process.env.AGOR_MASTER_SECRET) {
    // Check if we have a saved secret in config
    const savedSecret = config.daemon?.masterSecret;

    if (savedSecret) {
      process.env.AGOR_MASTER_SECRET = savedSecret;
      console.log('🔐 Using saved AGOR_MASTER_SECRET from config');
    } else {
      // Auto-generate a random master secret and persist it in config
      const { randomBytes } = await import('node:crypto');
      const { setConfigValue } = await import('@agor/core/config');

      const generatedSecret = randomBytes(32).toString('hex');
      await setConfigValue('daemon.masterSecret', generatedSecret);
      process.env.AGOR_MASTER_SECRET = generatedSecret;

      console.log('🔐 Generated and saved AGOR_MASTER_SECRET for API key encryption');
      console.log('   Secret stored in ~/.agor/config.yaml');
    }
  } else {
    console.log('🔐 API key encryption enabled (AGOR_MASTER_SECRET set)');
  }
}

// ---------------------------------------------------------------------------
// Main startup
// ---------------------------------------------------------------------------

export async function startup(ctx: StartupContext): Promise<void> {
  const {
    app,
    db,
    config,
    DAEMON_PORT,
    DAEMON_HOST,
    svcEnabled,
    safeService,
    getSocketServer,
    terminalsService,
  } = ctx;

  // 1. Cleanup orphaned tasks/sessions from previous daemon instance
  await cleanupOrphans(ctx);

  // 2. Initialize Health Monitor for periodic environment health checks
  const healthMonitor = await createHealthMonitor(app);

  // 3. Validate/generate master secret for API key encryption
  await ensureMasterSecret(config);

  // 4. Start server
  const server = await app.listen(DAEMON_PORT, DAEMON_HOST);

  const displayHost = DAEMON_HOST === '0.0.0.0' ? 'localhost' : DAEMON_HOST;
  console.log(
    `🚀 Agor daemon running at http://${displayHost}:${DAEMON_PORT} (bound to ${DAEMON_HOST})`
  );
  console.log(`   Health: http://${displayHost}:${DAEMON_PORT}/health`);
  console.log(
    `   Authentication: ${config.daemon?.allowAnonymous !== false ? '🔓 Anonymous (default)' : '🔐 Required'}`
  );
  console.log(`   Login: POST http://${displayHost}:${DAEMON_PORT}/authentication`);
  console.log(`   Services:`);
  console.log(`     - /sessions`);
  console.log(`     - /tasks`);
  console.log(`     - /messages`);
  console.log(`     - /boards`);
  console.log(`     - /repos`);
  console.log(`     - /mcp-servers`);
  console.log(`     - /config`);
  console.log(`     - /context`);
  console.log(`     - /users`);

  // Security warning: web terminal + simple unix mode = daemon-user shell access.
  // `allow_web_terminal` defaults to true, so the check treats undefined as enabled.
  if (config.execution?.allow_web_terminal !== false) {
    const unixMode = config.execution?.unix_user_mode ?? 'simple';
    if (unixMode === 'simple') {
      console.warn(
        '\x1b[33m⚠️  SECURITY: allow_web_terminal is enabled (default) with unix_user_mode=simple.\x1b[0m\n' +
          '   Any member-role user can open a shell running as the daemon user, with read\n' +
          '   access to ~/.agor/config.yaml, agor.db, and the JWT secret.\n' +
          "   Recommended: set execution.unix_user_mode to 'insulated' or 'strict' to\n" +
          '   isolate terminal sessions from the daemon process, or set\n' +
          '   execution.allow_web_terminal: false to disable the web terminal entirely.'
      );
    } else {
      console.log(`🖥️  Web terminal enabled (members+, unix mode: ${unixMode})`);
    }
  }

  // 5. Start scheduler service (background worker)
  let schedulerService: SchedulerService | null = null;
  if (svcEnabled('scheduler')) {
    schedulerService = new SchedulerService(db, app, {
      tickInterval: 30000, // 30 seconds
      gracePeriod: 120000, // 2 minutes
      debug: process.env.NODE_ENV !== 'production',
      unixUserMode: config.execution?.unix_user_mode ?? 'simple',
    });
    schedulerService.start();
    console.log(`🔄 Scheduler started (tick interval: 30s)`);
  }

  // 6. Initialize gateway: refresh channel state cache, then start Socket Mode listeners
  const gatewayService = safeService('gateway') as unknown as GatewayService | undefined;
  if (gatewayService) {
    gatewayService
      .refreshChannelState()
      .then(() => {
        return gatewayService.startListeners();
      })
      .catch((error: unknown) => {
        console.error('[gateway] Failed to start listeners:', error);
      });
  }

  // 7. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n⏳ Received ${signal}, shutting down gracefully...`);

    try {
      // Clean up health monitor
      healthMonitor.cleanup();

      // Clean up terminal sessions
      if (terminalsService) {
        console.log('🖥️  Cleaning up terminal sessions...');
        terminalsService.cleanup();
      }

      // Stop gateway listeners
      if (gatewayService) {
        console.log('🌐 Stopping gateway listeners...');
        await gatewayService.stopListeners();
      }

      // Stop scheduler
      if (schedulerService) {
        console.log('🔄 Stopping scheduler...');
        schedulerService.stop();
      }

      // Close Socket.io connections (this also closes the HTTP server)
      const socketServer = getSocketServer();
      if (socketServer) {
        console.log('🔌 Closing Socket.io and HTTP server...');
        // Disconnect all active clients first
        socketServer.disconnectSockets();
        // Give sockets a moment to disconnect
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        // Now close the server with a timeout
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            console.warn('⚠️  Server close timeout, forcing exit');
            resolve();
          }, 2000);

          socketServer?.close(() => {
            clearTimeout(timeout);
            console.log('✅ Server closed');
            resolve();
          });
        });
      } else {
        // Fallback: close HTTP server directly if Socket.io wasn't initialized
        await new Promise<void>((resolve, reject) => {
          server.close((err: Error | undefined) => {
            if (err) {
              console.error('❌ Error closing server:', err);
              reject(err);
            } else {
              console.log('✅ HTTP server closed');
              resolve();
            }
          });
        });
      }

      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
