/**
 * Startup & Shutdown
 *
 * Orchestrates post-boot steps: orphan cleanup, health monitor, master secret,
 * server listen, scheduler, gateway init, and graceful shutdown.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import {
  getAgorHome,
  resolveExecutorHeartbeatConfig,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  MessagesRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Id, Paginated, Session, SessionID, Task, TenantContext } from '@agor/core/types';
import { isTerminalTaskStatus, SessionStatus, TaskStatus } from '@agor/core/types';
import type { Application, SessionsServiceImpl, TasksServiceImpl } from './declarations.js';
import { ExecutorHeartbeatSupervisor } from './services/executor-heartbeat-supervisor.js';
import type { GatewayService } from './services/gateway.js';
import { HealthMonitor } from './services/health-monitor.js';
import { KnowledgeEmbeddingIndexer } from './services/knowledge-embedding-indexer.js';
import { SchedulerService } from './services/scheduler.js';
import type { TerminalsService } from './services/terminals.js';
import { appendSystemMessage } from './utils/append-system-message.js';
import { scrubManagedGitRemoteCredentials } from './utils/git-remote-credential-scan.js';

const DEBUG_STARTUP =
  process.env.AGOR_DEBUG_STARTUP === '1' || process.env.DEBUG?.includes('startup');

function startupDebug(...args: unknown[]): void {
  if (DEBUG_STARTUP) {
    console.debug(...args);
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface StartupContext {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  DAEMON_PORT: number;
  /** Bind address (default: 'localhost', use '0.0.0.0' for containers) */
  DAEMON_HOST: string;
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
  } catch (error) {
    // Non-fatal — worst case, startup treats the next restart as unexpected
    // and triggers orphan cleanup, which is the safer default. We surface
    // a single warning so operators debugging crash-classification in
    // read-only AGOR_HOME deployments (e.g. ConfigMap-mounted) can see
    // why the sentinel isn't doing anything.
    console.warn(
      '[startup] Could not write shutdown sentinel — next restart will be classified as a crash. ' +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
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

function startupTenantParams(config: AgorConfig): { tenant: TenantContext } {
  const multiTenancy = resolveMultiTenancyConfig(config);
  return {
    tenant: {
      tenant_id: multiTenancy.static_tenant_id,
      source: 'static',
    },
  };
}

async function runStartupTenantDatabaseScope<T>(
  ctx: Pick<StartupContext, 'config' | 'db'>,
  work: () => Promise<T>
): Promise<T> {
  // Startup/background daemon jobs have no request auth context. Keep the
  // historical bootstrap/static tenant behavior explicit at the DB boundary so
  // guarded required_from_auth databases fail closed everywhere else.
  return runWithTenantDatabaseScope(ctx.db, startupTenantParams(ctx.config).tenant.tenant_id, work);
}

interface OrphanCleanupResult {
  wasGraceful: boolean;
  orphanedTasks: Task[];
  orphanedSessions: Session[];
  sessionIdsWithOrphanedTasks: Set<string>;
  queuedTasks: Task[];
  sessionsResetFromOrphanedTasks: number;
}

export async function cleanupOrphanStatuses(ctx: StartupContext): Promise<OrphanCleanupResult> {
  return runStartupTenantDatabaseScope(ctx, () => cleanupOrphanStatusesInTenantScope(ctx));
}

async function cleanupOrphanStatusesInTenantScope(
  ctx: StartupContext
): Promise<OrphanCleanupResult> {
  const { app, sessionsService } = ctx;

  // Get tasks service from the app (registered during services phase)
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;
  // Startup cleanup runs before any user request/auth context exists. In
  // auth-resolved multi-tenant deployments, scope cleanup to the configured
  // bootstrap/static tenant instead of failing daemon boot. Tenant-specific
  // crash cleanup for every active tenant belongs in a later control-plane/DataPlane
  // reconciler pass; startup must stay non-blocking for launch-auth tenants.
  const startupParams = startupTenantParams(ctx.config);

  // Determine restart type before touching anything — sentinel is consumed here
  const wasGraceful = await readAndClearSentinel();

  // Find all orphaned executor-owned tasks (running, stopping, awaiting_permission, awaiting_input)
  const orphanedTasks = await tasksService.getOrphaned(startupParams as never);

  if (orphanedTasks.length > 0) {
    for (const task of orphanedTasks) {
      await tasksService.patch(
        task.task_id,
        {
          status: TaskStatus.STOPPED,
        },
        startupParams as never
      );
      startupDebug(
        `[startup] stopped orphaned task ${shortId(task.task_id)} (was: ${task.status})`
      );
    }
  }

  // Wipe the queue BEFORE making any session promptable. Running tasks are marked STOPPED above,
  // which invalidates the ordering premise of anything waiting behind them — a queued prompt
  // typically depends on whatever was running first. Wiping here prevents the session after-patch
  // hook (triggered below) from draining queued tasks that should be discarded.
  const queuedResult = (await tasksService.find({
    query: { status: TaskStatus.QUEUED, $limit: 1000 },
    ...startupParams,
  })) as unknown as Paginated<Task>;
  const queuedTasks = queuedResult.data;

  if (queuedTasks.length > 0) {
    for (const task of queuedTasks) {
      await tasksService.patch(
        task.task_id,
        {
          status: TaskStatus.STOPPED,
        },
        startupParams as never
      );
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
      ...startupParams,
    })) as unknown as Paginated<Session>;
    orphanedSessions.push(...result.data);
  }

  if (orphanedSessions.length > 0) {
    for (const session of orphanedSessions) {
      // IMPORTANT: Use app.service() instead of sessionsService to go through
      // FeathersJS service layer and trigger app.publish() for WebSocket events
      await app.service('sessions').patch(
        session.session_id,
        {
          status: SessionStatus.IDLE,
          ready_for_prompt: true,
        },
        startupParams as never
      );
      startupDebug(
        `   ✓ Marked session ${shortId(session.session_id)} as idle (was: ${session.status})`
      );
    }
  }

  // Also check for sessions that had orphaned tasks (even if session wasn't in RUNNING/STOPPING)
  const sessionIdsWithOrphanedTasks = new Set(
    orphanedTasks.map((t: Task) => t.session_id as string)
  );
  let sessionsResetFromOrphanedTasks = 0;
  if (sessionIdsWithOrphanedTasks.size > 0) {
    for (const sessionId of sessionIdsWithOrphanedTasks) {
      const session = await sessionsService.get(sessionId as Id, startupParams as never);
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
          startupParams as never
        );
        sessionsResetFromOrphanedTasks++;
        startupDebug(
          `   ✓ Marked session ${shortId(sessionId)} as idle (had orphaned tasks, was: ${session.status})`
        );
      }
    }
  }

  // Fix sessions that are IDLE but not promptable *because a kill interrupted
  // them* — the daemon died during the stop path after writing status=idle but
  // before writing ready_for_prompt=true, or the executor exit raced the stop
  // endpoint. IDLE + ready_for_prompt=false is NOT inherently orphaned state:
  // the UI also uses ready_for_prompt as the unread/attention flag (opening a
  // conversation patches it false, branch cards highlight while it's true —
  // see SessionPromptState in @agor/core/types), so it is the normal resting
  // state of every read session. Discriminate by the session's most recent
  // task: only sessions whose latest task was non-terminal at boot (just
  // orphan-stopped / queue-wiped above, or still in an executing state) were
  // actually interrupted; read sessions have a terminal latest task from a
  // previous run and must be left untouched.
  const bootInterruptedTaskIds = new Set<string>([
    ...orphanedTasks.map((t: Task) => t.task_id as string),
    ...queuedTasks.map((t: Task) => t.task_id as string),
  ]);

  const idleNotReadyResult = (await sessionsService.find({
    query: { status: SessionStatus.IDLE, ready_for_prompt: false, $limit: 1000 },
    ...startupParams,
  })) as unknown as Paginated<Session>;

  const stuckIdleSessions: Session[] = [];
  for (const session of idleNotReadyResult.data) {
    // Sessions maintain an ordered task-ID list; the last entry is the most
    // recent task (same convention as injectRestartNotices below).
    const latestTaskId = session.tasks?.at(-1);
    if (!latestTaskId) {
      continue; // never ran a task — nothing was interrupted
    }

    let wasInterrupted = bootInterruptedTaskIds.has(latestTaskId as string);
    if (!wasInterrupted) {
      try {
        const latestTask = await tasksService.get(latestTaskId, startupParams as never);
        wasInterrupted = !isTerminalTaskStatus(latestTask.status);
      } catch {
        // Task row missing/unreadable — fail closed: don't re-flag the session.
      }
    }
    if (!wasInterrupted) {
      continue;
    }

    stuckIdleSessions.push(session);
    await app
      .service('sessions')
      .patch(session.session_id, { ready_for_prompt: true }, startupParams as never);
    startupDebug(
      `   ✓ Unblocked stuck-idle session ${shortId(session.session_id)} (ready_for_prompt was false, latest task interrupted)`
    );
  }

  const cleanupParts: string[] = [
    `${orphanedTasks.length} orphaned task(s) stopped`,
    `${orphanedSessions.length} active session(s) reset`,
    `${queuedTasks.length} queued task(s) stopped`,
  ];
  if (sessionsResetFromOrphanedTasks > 0) {
    cleanupParts.push(`${sessionsResetFromOrphanedTasks} task-owned session(s) reset`);
  }
  if (stuckIdleSessions.length > 0) {
    cleanupParts.push(`${stuckIdleSessions.length} stuck-idle session(s) unblocked`);
  }
  console.log(`[startup] orphan cleanup: ${cleanupParts.join(', ')}`);

  return {
    wasGraceful,
    orphanedTasks,
    orphanedSessions,
    sessionIdsWithOrphanedTasks,
    queuedTasks,
    sessionsResetFromOrphanedTasks,
  };
}

async function injectRestartNotices(
  ctx: StartupContext,
  cleanupResult: OrphanCleanupResult
): Promise<void> {
  return runStartupTenantDatabaseScope(ctx, () =>
    injectRestartNoticesInTenantScope(ctx, cleanupResult)
  );
}

async function injectRestartNoticesInTenantScope(
  ctx: StartupContext,
  cleanupResult: OrphanCleanupResult
): Promise<void> {
  const { app, db, sessionsService } = ctx;
  const { wasGraceful, orphanedTasks, orphanedSessions, sessionIdsWithOrphanedTasks } =
    cleanupResult;

  // Get tasks service from the app (registered during services phase)
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;
  const startupParams = startupTenantParams(ctx.config);

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

  if (affectedSessionIds.size === 0) {
    return;
  }

  console.log(`🧹 Injecting daemon restart notices for ${affectedSessionIds.size} session(s)...`);

  const restartType = wasGraceful ? ('daemon_restart' as const) : ('daemon_crash' as const);
  const messageText = wasGraceful
    ? 'The Agor daemon was restarted while this session was running.'
    : 'The Agor daemon restarted unexpectedly while this session was running.';

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
        const session = await sessionsService.get(sessionId as Id, startupParams as never);
        const latestTaskId = session.tasks?.at(-1);
        if (latestTaskId) {
          attachTask = await tasksService.get(latestTaskId, startupParams as never);
        }
      }
      if (!attachTask) {
        // No task exists — message would be invisible (transcript is task-scoped).
        // This session has never had any work, so there is nothing for the user to resume.
        console.log(`   ⏭  Session ${shortId(sessionId)} has no tasks — skipping restart notice`);
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
            `   ⏭  Session ${shortId(sessionId)} already has a restart notice — skipping`
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

      console.log(`   ✉  Injected ${restartType} notice into session ${shortId(sessionId)}`);
    } catch (err) {
      console.warn(
        `   ⚠️  Failed to inject restart notice into session ${shortId(sessionId)}:`,
        err
      );
    }
  }
}

export function runPostStartJob(name: string, job: () => Promise<void> | void): void {
  void Promise.resolve()
    .then(() => job())
    .then(() => {
      startupDebug(`[startup] post-start job completed: ${name}`);
    })
    .catch((error: unknown) => {
      console.warn(`[startup] post-start job failed: ${name}`, error);
    });
}

// ---------------------------------------------------------------------------
// Master secret
// ---------------------------------------------------------------------------

async function ensureMasterSecret(config: AgorConfig): Promise<void> {
  // AGOR_MASTER_SECRET: env > existing config value > generate-and-persist >
  // fail-fast. See setup/persisted-secret.ts and the doc §1.5 (H3).
  //
  // Same fail-fast reasoning as the JWT path: a fresh master secret on every
  // restart corrupts every stored encrypted API key.
  const { randomBytes } = await import('node:crypto');
  const { resolvePersistedSecret } = await import('./setup/persisted-secret.js');
  const resolution = await resolvePersistedSecret({
    name: 'AGOR_MASTER_SECRET (API key encryption)',
    envVar: 'AGOR_MASTER_SECRET',
    existing: config.daemon?.masterSecret,
    configKey: 'daemon.masterSecret',
    generate: () => randomBytes(32).toString('hex'),
  });
  // Side effect: downstream code (encrypted-creds resolver, etc.) reads this
  // off process.env, not off a parameter. Keep that contract.
  process.env.AGOR_MASTER_SECRET = resolution.value;
  switch (resolution.source) {
    case 'env':
      console.log('🔐 API key encryption enabled (AGOR_MASTER_SECRET set)');
      break;
    case 'config':
      console.log('🔐 Using saved AGOR_MASTER_SECRET from config');
      break;
    case 'generated':
      console.log('🔐 Generated and saved AGOR_MASTER_SECRET for API key encryption');
      console.log('   Secret stored in ~/.agor/config.yaml');
      break;
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
    safeService,
    getSocketServer,
    terminalsService,
  } = ctx;

  // 1. Correct orphaned task/session state from previous daemon instance.
  // Keep this blocking so clients never see stale RUNNING/AWAITING states from
  // a previous process. More expensive UX/audit follow-ups are post-start jobs.
  const orphanCleanupResult = await cleanupOrphanStatuses(ctx);

  // 2. Register Health Monitor listeners before serving requests. The initial
  // full scan of already-running environments is deferred until after listen.
  const startupMultiTenancy = resolveMultiTenancyConfig(config);
  const healthMonitor = new HealthMonitor(app, {
    defaultParams: startupTenantParams(config),
    db,
    tenantId:
      startupMultiTenancy.mode === 'static' ? startupMultiTenancy.static_tenant_id : undefined,
    requireTenantParams: startupMultiTenancy.mode !== 'static',
  });

  // 3. Validate/generate master secret for API key encryption
  await ensureMasterSecret(config);

  // 4. Start server
  const server = await app.listen(DAEMON_PORT, DAEMON_HOST);

  const displayHost = DAEMON_HOST === '0.0.0.0' ? 'localhost' : DAEMON_HOST;
  console.log(
    `🚀 Agor daemon running at http://${displayHost}:${DAEMON_PORT} (bound to ${DAEMON_HOST})`
  );
  console.log(
    `   health=/health auth=required services=/sessions,/tasks,/messages,/boards,/repos,/mcp-servers,/context,/users`
  );

  runPostStartJob('health-monitor-initialize', () => healthMonitor.initialize());
  runPostStartJob('daemon-restart-notices', () => injectRestartNotices(ctx, orphanCleanupResult));

  // Non-blocking credential spill repair. If an agent/user wrote a PAT into a
  // git remote URL while the daemon was down, scrub persisted repo metadata
  // and Agor-managed repo/worktree git configs after the API is already
  // accepting requests. This is best-effort; filesystem config scrubbing
  // deliberately skips registered local repos to avoid surprising writes
  // outside Agor-managed storage.
  runPostStartJob('git-remote-credential-scrub', () =>
    runStartupTenantDatabaseScope(ctx, () => scrubManagedGitRemoteCredentials(db))
  );

  // Log the host IP that will be frozen into env command templates as
  // {{host.ip_address}}. Explicit config overrides autodetection.
  runPostStartJob('host-ip-log', async () => {
    const { resolveHostIpAddress } = await import('@agor/core/utils/host-ip');
    const hostIp = resolveHostIpAddress(config.daemon?.host_ip_address);
    const source = config.daemon?.host_ip_address ? 'config' : hostIp ? 'autodetected' : 'unknown';
    startupDebug(`🌐 Host IP for env templates: ${hostIp ?? '(none)'} (source: ${source})`);
  });

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

  // 5. Start executor heartbeat stale supervisor
  const heartbeatConfig = resolveExecutorHeartbeatConfig(config.execution);
  const heartbeatSupervisor = new ExecutorHeartbeatSupervisor({ app, config: heartbeatConfig });
  heartbeatSupervisor.start();
  if (heartbeatConfig.enabled) {
    console.log(
      `💓 Executor heartbeat supervisor started (interval: ${heartbeatConfig.interval_ms}ms, stale after: ${heartbeatConfig.stale_after_ms}ms)`
    );
  } else {
    console.log('💓 Executor heartbeat disabled');
  }

  // 6. Start scheduler service (background worker)
  let schedulerService: SchedulerService | null = null;
  {
    const multiTenancy = resolveMultiTenancyConfig(config);
    schedulerService = new SchedulerService(db, app, {
      tickInterval: 30000, // 30 seconds
      gracePeriod: 120000, // 2 minutes
      debug: process.env.NODE_ENV !== 'production',
      unixUserMode: config.execution?.unix_user_mode ?? 'simple',
      // Static mode keeps the historical single-tenant scope. Auth-resolved
      // multi-tenant mode leaves this undefined so the scheduler discovers due
      // schedule tenant metadata at the DB boundary on each tick.
      tenantId: multiTenancy.mode === 'static' ? multiTenancy.static_tenant_id : undefined,
    });
    app.set('scheduler', schedulerService);
    schedulerService.start();
    console.log('🔄 Scheduler started (tick interval: 30s)');
  }

  // 7. Start Knowledge embedding indexer (no-op unless semantic search is configured)
  let knowledgeEmbeddingIndexer: KnowledgeEmbeddingIndexer | null = null;
  knowledgeEmbeddingIndexer = new KnowledgeEmbeddingIndexer(db, {
    tenantId: startupTenantParams(config).tenant.tenant_id,
  });
  knowledgeEmbeddingIndexer.start();
  app.set('knowledgeEmbeddingIndexer', knowledgeEmbeddingIndexer);
  console.log('🧠 Knowledge embedding indexer started');

  // 8. Initialize gateway: refresh channel state cache, then start Socket Mode listeners
  const gatewayService = safeService('gateway') as unknown as GatewayService | undefined;
  if (gatewayService) {
    runStartupTenantDatabaseScope(ctx, () => gatewayService.refreshChannelState())
      .then(() => {
        return runStartupTenantDatabaseScope(ctx, () => gatewayService.startListeners());
      })
      .catch((error: unknown) => {
        console.error('[gateway] Failed to start listeners:', error);
      });
  }

  // 8. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n⏳ Received ${signal}, shutting down gracefully...`);

    // Write sentinel before anything else — if later steps hang or fail and the
    // process gets SIGKILL'd, the sentinel is already on disk and startup will
    // correctly classify this as a graceful restart rather than a crash.
    await writeCleanShutdownSentinel(signal);

    try {
      // Clean up health monitor
      healthMonitor.cleanup();

      // Stop heartbeat supervisor
      heartbeatSupervisor.stop();

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

      // Stop Knowledge embedding indexer
      if (knowledgeEmbeddingIndexer) {
        console.log('🧠 Stopping Knowledge embedding indexer...');
        knowledgeEmbeddingIndexer.stop();
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
