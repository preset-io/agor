/**
 * Startup & Shutdown
 *
 * Orchestrates post-boot steps: orphan cleanup, health monitor, master secret,
 * server listen, scheduler, gateway init, and graceful shutdown.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import { getAgorHome } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import { MessagesRepository, SessionRepository } from '@agor/core/db';
import type { Id, Paginated, Session, SessionID, Task } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import type { Application, SessionsServiceImpl, TasksServiceImpl } from './declarations.js';
import type { GatewayService } from './services/gateway.js';
import { createHealthMonitor } from './services/health-monitor.js';
import { SchedulerService } from './services/scheduler.js';
import type { TerminalsService } from './services/terminals.js';
import { appendSystemMessage } from './utils/append-system-message.js';

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
// Sentinel file — distinguishes graceful shutdown from crashes
// ---------------------------------------------------------------------------

const SENTINEL_FILENAME = 'daemon-shutdown-clean.flag';
const SENTINEL_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — stale sentinels are treated as crashes

interface ShutdownSentinel {
  timestamp: string;
  signal: string;
}

async function writeCleanShutdownSentinel(signal: string): Promise<void> {
  try {
    const sentinel: ShutdownSentinel = { timestamp: new Date().toISOString(), signal };
    await fs.writeFile(
      path.join(getAgorHome(), SENTINEL_FILENAME),
      JSON.stringify(sentinel),
      'utf8'
    );
  } catch {
    // Non-fatal — worst case, startup treats this restart as unexpected
  }
}

/** Read and immediately delete the sentinel. Returns whether shutdown was graceful. */
async function readAndClearSentinel(): Promise<boolean> {
  const sentinelPath = path.join(getAgorHome(), SENTINEL_FILENAME);
  try {
    const raw = await fs.readFile(sentinelPath, 'utf8');
    await fs.unlink(sentinelPath);
    const sentinel = JSON.parse(raw) as ShutdownSentinel;
    const age = Date.now() - new Date(sentinel.timestamp).getTime();
    return age < SENTINEL_MAX_AGE_MS;
  } catch {
    // Missing file = crash, stale/corrupt = treat as crash
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

async function cleanupOrphans(ctx: StartupContext): Promise<void> {
  const { app, db, sessionsService } = ctx;

  // Get tasks service from the app (registered during services phase)
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;

  console.log('🧹 Cleaning up orphaned tasks and sessions...');

  // Determine restart type before touching anything — sentinel is consumed here
  const wasGraceful = await readAndClearSentinel();

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

  // Inject a system message into every affected session so the user (and the
  // agent on resume) see an in-transcript explanation — not a toast, a
  // persistent record in the conversation. Contrast with PR #1116 (filtered
  // high-frequency SDK lifecycle noise): this is intentional, low-frequency,
  // and user-meaningful.
  //
  // The message MUST be attached to a task: the reactive client drops taskless
  // messages (ReactiveSessionState groups messages by task_id), so a notice
  // with no task_id would be silently invisible in the UI.
  const affectedSessionIds = new Set<string>([
    ...orphanedSessions.map((s) => s.session_id as string),
    ...Array.from(sessionIdsWithOrphanedTasks),
  ]);

  if (affectedSessionIds.size > 0) {
    const restartType = wasGraceful ? 'daemon_restart' : ('daemon_crash' as const);
    const messageText = wasGraceful
      ? 'The Agor daemon was restarted while this session was running. Ask the agent to resume where it left off.'
      : 'The Agor daemon restarted unexpectedly while this session was running. Ask the agent to resume where it left off.';

    // Build session → last orphaned task map so we can attach notices to a task_id.
    // Prefer orphaned tasks (they were the active tasks at shutdown); fall back to
    // querying the session's most-recent task if none was orphaned.
    const lastOrphanedTaskBySession = new Map<string, Task>();
    for (const task of orphanedTasks) {
      const sid = task.session_id as string;
      const existing = lastOrphanedTaskBySession.get(sid);
      if (!existing || task.created_at > existing.created_at) {
        lastOrphanedTaskBySession.set(sid, task);
      }
    }

    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessagesRepository(db);

    for (const sessionId of affectedSessionIds) {
      try {
        // Resolve the task to attach the notice to
        let attachTask = lastOrphanedTaskBySession.get(sessionId);
        if (!attachTask) {
          // Sessions maintain an ordered task-ID list; the last entry is the most
          // recent task without relying on TasksService.find() sort behavior.
          const session = await sessionsService.get(sessionId as Id);
          const latestTaskId = session.tasks?.at(-1);
          if (latestTaskId) {
            attachTask = await tasksService.get(latestTaskId);
          }
        }
        if (!attachTask) {
          // No task exists — message would be invisible (transcript is task-scoped).
          // This session has never had any work, so there is nothing for the user to resume.
          console.log(
            `   ⏭  Session ${sessionId.substring(0, 8)} has no tasks — skipping restart notice`
          );
          continue;
        }

        // Idempotency: skip if the last message is already a daemon restart notice
        // (guards against rapid restart cycles piling up notices before the user responds)
        const messageCount = await sessionRepo.countMessages(sessionId);
        if (messageCount > 0) {
          const lastMessages = await messageRepo.findByRange(
            sessionId as SessionID,
            messageCount - 1,
            messageCount - 1
          );
          const last = lastMessages[0];
          if (last?.type === 'daemon_restart' || last?.type === 'daemon_crash') {
            console.log(
              `   ⏭  Session ${sessionId.substring(0, 8)} already has a restart notice — skipping`
            );
            continue;
          }
        }

        const injectedMessage = await appendSystemMessage({
          app,
          db,
          sessionId,
          taskId: attachTask.task_id,
          type: restartType,
          content: messageText,
          metadata: { source: 'agor' },
        });

        // Extend the task's message_range.end_index so the notice is counted
        // and loaded within the task's window in the UI.
        // Pass only end_index: TaskRepository.update() deep-merges with the live
        // DB row, preserving fields written by the STOPPED patch (e.g. end_timestamp).
        if (attachTask.message_range) {
          await tasksService.patch(attachTask.task_id, {
            message_range: { end_index: injectedMessage.index } as Task['message_range'],
          });
        }

        console.log(
          `   ✉  Injected ${restartType} notice into session ${sessionId.substring(0, 8)}`
        );
      } catch (err) {
        console.warn(
          `   ⚠️  Failed to inject restart notice into session ${sessionId.substring(0, 8)}:`,
          err
        );
      }
    }
  }

  // Wipe the queue. Running tasks are marked STOPPED above, which invalidates
  // the ordering premise of anything that was waiting behind them — a queued
  // prompt typically depends on whatever was running first. Rather than carry
  // an ambiguous queue across the restart, mark all QUEUED tasks as STOPPED
  // (mirroring how we treat the running task — no work was lost, the user
  // can re-issue from `full_prompt` if they still want it).
  const queuedResult = (await tasksService.find({
    query: { status: TaskStatus.QUEUED, $limit: 1000 },
  })) as unknown as Paginated<Task>;
  const queuedTasks = queuedResult.data;

  if (queuedTasks.length > 0) {
    console.log(`   Found ${queuedTasks.length} queued task(s) — wiping queue on restart`);
    for (const task of queuedTasks) {
      await tasksService.patch(task.task_id, {
        status: TaskStatus.STOPPED,
      });
    }
  }

  if (orphanedTasks.length === 0 && orphanedSessions.length === 0 && queuedTasks.length === 0) {
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
  console.log(`   Authentication: 🔐 Required`);
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

  // Log the host IP that will be frozen into env command templates as
  // {{host.ip_address}}. Explicit config overrides autodetection.
  try {
    const { resolveHostIpAddress } = await import('@agor/core/utils/host-ip');
    const hostIp = resolveHostIpAddress(config.daemon?.host_ip_address);
    const source = config.daemon?.host_ip_address ? 'config' : hostIp ? 'autodetected' : 'unknown';
    console.log(`🌐 Host IP for env templates: ${hostIp ?? '(none)'} (source: ${source})`);
  } catch (err) {
    console.warn('⚠️  Failed to resolve host IP for env templates:', err);
  }

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
    // Expose on app so route handlers (e.g. /worktrees/:id/execute-schedule-now)
    // can reuse the scheduler's spawn code path.
    app.set('scheduler', schedulerService);
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

    // Write sentinel before anything else — if later steps hang or fail and the
    // process gets SIGKILL'd, the sentinel is already on disk and startup will
    // correctly classify this as a graceful restart rather than a crash.
    await writeCleanShutdownSentinel(signal);

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
