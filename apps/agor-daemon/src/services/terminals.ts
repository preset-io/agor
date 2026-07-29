/**
 * Terminals Service
 *
 * Manages Zellij-based terminal sessions via executor processes.
 * REQUIRES Zellij to be installed on the system.
 *
 * Features:
 * - Full terminal emulation (vim, nano, htop, etc.)
 * - Job control (Ctrl+C, Ctrl+Z)
 * - ANSI colors and escape codes
 * - Persistent sessions via Zellij (survive daemon restarts)
 * - One executor per user, one Zellij tab per branch
 *
 * Architecture:
 * - Executor process owns PTY running `zellij attach`
 * - PTY I/O streams over Feathers channels: user/${userId}/terminal
 * - Zellij handles session/tab multiplexing
 * - xterm.js frontend for rendering
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createUserProcessEnvironment,
  loadConfig,
  resolveUserEnvironment,
} from '@agor/core/config';
import {
  BranchRepository,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  shortId,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, Branch, BranchID, UserID } from '@agor/core/types';
import {
  getBranchSymlinkPath,
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  UnixUserNotFoundError,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from '../utils/agentic-tool-runtime.js';
import { hasBranchPermission } from '../utils/branch-authorization.js';
import { generateScopedServiceToken, spawnExecutorFireAndForget } from '../utils/spawn-executor.js';

/**
 * TTL for the terminal executor's scoped service token. Terminals are
 * long-lived and the executor re-authenticates with the same token across
 * reconnects, so this must comfortably exceed a session's lifetime (the 5m
 * service-token default would break reconnection). 30 days covers realistic
 * usage.
 *
 * SECURITY: the `terminal_user_id` claim makes this a RESTRICTED identity —
 * ServiceJWTStrategy resolves it to `_isTerminalExecutor` (NOT a full
 * `_isServiceAccount`), and `rejectTerminalExecutorIdentity` (composed into
 * `requireAuth`) REJECTS it from every REST/Feathers service call. It is valid
 * ONLY for its own user's Socket.IO terminal channel. That confinement is what
 * makes a long TTL acceptable (there's no revocation story for a stateless
 * JWT): a leaked token grants terminal-channel I/O for that one user for its
 * lifetime — no broader daemon access.
 */
const TERMINAL_EXECUTOR_TOKEN_TTL = '30d';

/**
 * Zellij 0.44 exits when the canonical 24-character short ID is prefixed with
 * `agor-`. Hash the full user ID into a compact, stable operational identity
 * instead of truncating the time-ordered UUID prefix shared by nearby users.
 */
export function buildZellijSessionName(userId: UserID): string {
  return `agor-${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
}

interface CreateTerminalData {
  rows?: number;
  cols?: number;
  branchId?: BranchID; // Branch context for Zellij integration
  /** Optional Zellij tab name to focus once the executor is up. */
  focusTabName?: string;
  /**
   * Compatibility-only input accepted from stale Claude CLI clients.
   * Any presence is rejected before executor adoption, spawn, or tab focus.
   */
  ensureCliSessionId?: string;
}

/**
 * Build the Zellij tab identity for a branch shell.
 *
 * Zellij tab operations are keyed only by tab title. A user has one shared
 * Zellij session, so plain `branch.name` collides when two branches with the
 * same display name exist on different boards or repos. Keep the title readable
 * while making the operational identity stable by branch id.
 */
export function buildBranchShellTabName(branch: Pick<Branch, 'branch_id' | 'name'>): string {
  return `${branch.name} · ${shortId(branch.branch_id)}`;
}

function safeRealpath(pathToResolve: string): string | null {
  try {
    return fs.realpathSync(pathToResolve);
  } catch {
    return null;
  }
}

/**
 * Resolve the cwd for a branch shell.
 *
 * In Unix impersonation modes users get convenience symlinks under
 * ~/agor/worktrees/<branch-name>. Those links are name-keyed, so same-name
 * branches can collide. Only use the symlink when canonical resolution proves
 * it targets the requested branch path; otherwise fall back to branch.path.
 */
export function resolveBranchShellCwd(
  branch: Pick<Branch, 'name' | 'path'>,
  finalUnixUser: string | null
): string {
  if (!finalUnixUser) return branch.path;

  const symlinkPath = getBranchSymlinkPath(finalUnixUser, branch.name);
  const symlinkRealpath = safeRealpath(symlinkPath);
  if (!symlinkRealpath) return branch.path;

  const branchRealpath = safeRealpath(branch.path);
  if (!branchRealpath) return branch.path;

  return symlinkRealpath === branchRealpath ? symlinkPath : branch.path;
}

/**
 * Check if Zellij is installed
 */
function isZellijAvailable(): boolean {
  try {
    execSync('which zellij', { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** Module-level flag tracking if Zellij warning has been shown */
let zellijWarningShown = false;

/**
 * Write user environment variables to a shell script
 * This allows shells spawned in Zellij tabs to source the env vars
 *
 * @param userId - User ID for naming the file
 * @param env - Environment variables to export
 * @param chownTo - Optional Unix username to chown the file to (for impersonation)
 * @returns Path to the env file, or null on error
 */
function writeEnvFile(
  userId: UserID | undefined,
  env: Record<string, string>,
  chownTo?: string | null
): string | null {
  if (!userId) return null;

  try {
    const tmpDir = os.tmpdir();
    const envFile = path.join(tmpDir, `agor-env-${shortId(userId)}.sh`);

    // Build shell script to export env vars
    const exportLines = Object.entries(env)
      .filter(([key]) => {
        // Skip system/shell env vars that shouldn't be overridden
        const skipKeys = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'COLORTERM'];
        return !skipKeys.includes(key);
      })
      .map(([key, value]) => {
        // Escape single quotes in value
        const escapedValue = value.replace(/'/g, "'\\''");
        return `export ${key}='${escapedValue}'`;
      });

    const scriptContent = `#!/bin/sh
# Agor user environment variables
# Auto-generated - do not edit manually
${exportLines.join('\n')}
`;

    // Write file with restrictive permissions initially
    fs.writeFileSync(envFile, scriptContent, { mode: 0o600 });

    // If we're impersonating a user, chown the file to them so they can read it
    // Without this, impersonated users can't source the env file (permission denied)
    if (chownTo) {
      try {
        // CRITICAL: Use -n flag to prevent password prompts that freeze the system
        // Also add timeout to prevent any hangs
        execSync(`sudo -n chown "${chownTo}" "${envFile}"`, { stdio: 'pipe', timeout: 2000 });
      } catch (chownError) {
        console.warn(`Failed to chown env file to ${chownTo}:`, chownError);
        // Continue anyway - file may still be readable in some configurations
      }
    }

    return envFile;
  } catch (error) {
    console.warn('Failed to write user env file:', error);
    return null;
  }
}

/**
 * Terminals service - manages Zellij sessions via executor
 *
 * Architecture:
 * - One executor per user (spawned when user opens first terminal)
 * - Executor owns a single PTY running `zellij attach`
 * - Zellij manages multiple tabs (one per branch)
 * - PTY I/O streams over Feathers channel: user/${userId}/terminal
 */
export class TerminalsService {
  private app: Application;
  private db: TenantScopeAwareDatabase;

  /** Whether Zellij is available on this system */
  private zellijAvailable: boolean;

  constructor(app: Application, db: TenantScopeAwareDatabase) {
    this.app = app;
    this.db = db;

    // The socketio relay converts the executor's readiness/failure acks into
    // app events (it can't reach this service instance directly). Readiness
    // gates the tab choreography and tells the browser channel it may leave
    // its "connecting" state.
    (this.app as unknown as import('node:events').EventEmitter).on(
      'terminal:ready',
      (data: { userId?: string }) => {
        if (data?.userId) this.handleExecutorReady(data.userId as UserID);
      }
    );
    (this.app as unknown as import('node:events').EventEmitter).on(
      'terminal:error',
      (data: { userId?: string; message?: string }) => {
        if (data?.userId) this.handleExecutorError(data.userId as UserID, data.message);
      }
    );

    // Check if Zellij is available - warn but don't fail
    this.zellijAvailable = isZellijAvailable();

    if (!this.zellijAvailable) {
      if (!zellijWarningShown) {
        console.warn(
          '\x1b[33m⚠️  Zellij is not installed or not available in PATH.\x1b[0m\n' +
            'Terminal functionality will be unavailable.\n' +
            'To enable terminals, install Zellij:\n' +
            '  - Ubuntu/Debian: curl -L https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz | tar -xz -C /usr/local/bin\n' +
            '  - macOS: brew install zellij\n' +
            '  - See: https://zellij.dev/documentation/installation'
        );
        zellijWarningShown = true;
      }
    } else {
      console.log('\x1b[36m✅ Zellij detected\x1b[0m - persistent terminal sessions enabled');
    }
  }

  private withTenantDatabase<T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>): Promise<T> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new Error('Missing active tenant context for terminal database access');
    }
    return runWithTenantDatabaseScope(this.db, tenantId, work);
  }

  /**
   * Create a new terminal session
   *
   * Spawns an executor with Zellij for persistent terminal sessions.
   * One executor per user, one Zellij tab per branch.
   */
  async create(
    data: CreateTerminalData,
    params?: AuthenticatedParams
  ): Promise<{
    userId: UserID;
    channel: string;
    sessionName: string;
    isNew: boolean;
    branchName?: string;
    /**
     * Whether the executor's PTY bridge is confirmed up right now (ready ack
     * received, or a live executor adopted). The browser flips to connected
     * immediately when true; when false it waits for the async `terminal:ready`
     * channel event rather than trusting this call's resolution.
     */
    ready: boolean;
  }> {
    if (!getCurrentTenantId()) {
      throw new Error('Missing active tenant context for terminal creation');
    }
    if (data.ensureCliSessionId !== undefined) {
      throw new BadRequest(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
    }

    // Check if Zellij is available
    if (!this.zellijAvailable) {
      throw new Error(
        'Terminal functionality is unavailable: Zellij is not installed.\n' +
          'Please install Zellij to enable terminal support.'
      );
    }

    // Branch RBAC check: if a branch is provided and RBAC is enabled,
    // the user must have at least 'session' permission on that branch.
    // This prevents members from opening a terminal tab in a branch they
    // cannot see or prompt in.
    if (data.branchId && params?.provider) {
      const config = await loadConfig();
      const rbacEnabled = config.execution?.branch_rbac === true;
      if (rbacEnabled) {
        const userId = params?.user?.user_id as UserID | undefined;
        if (!userId) {
          throw new Forbidden('Authentication required to open terminals');
        }
        await this.withTenantDatabase(async (tenantDb) => {
          const branchRepo = new BranchRepository(tenantDb);
          const branch = await branchRepo.findById(data.branchId!);
          if (!branch) {
            throw new Forbidden(`Branch not found: ${data.branchId}`);
          }
          const isOwner = await branchRepo.isOwner(branch.branch_id, userId);
          const effectivePermission = await branchRepo.resolveUserPermission(branch, userId);
          const allowSuperadmin = config.execution?.allow_superadmin === true;
          const userRole = params?.user?.role as string | undefined;
          if (
            !hasBranchPermission(
              branch,
              userId,
              isOwner,
              'session',
              userRole,
              allowSuperadmin,
              effectivePermission
            )
          ) {
            throw new Forbidden(
              `You need 'session' permission on branch ${branch.name} to open a terminal there.`
            );
          }
        });
      }
    }

    return this.createExecutorTerminal(
      {
        branchId: data.branchId,
        cols: data.cols,
        rows: data.rows,
        focusTabName: data.focusTabName,
      },
      params
    );
  }

  /**
   * Cleanup all terminals on shutdown
   */
  cleanup(): void {
    this.cleanupExecutorTerminals();
  }

  /**
   * Look for a running `zellij attach <sessionName>` process. Used at
   * cold-start to detect executors that survived a daemon restart so
   * we adopt instead of spawning a duplicate.
   *
   * **Anchored regex**: `^[^ ]*zellij attach <sessionName>`. Without
   * the `^` anchor, `pgrep -f` false-positives on ANY process whose
   * full command line contains the search string — including, e.g., a
   * sibling `bash -c 'something something zellij attach agor-X'` that
   * happens to mention it. The anchor restricts the match to processes
   * whose first argv element is the `zellij` binary (with optional
   * path prefix).
   */
  private async detectExistingExecutor(sessionName: string): Promise<boolean> {
    try {
      execSync(`pgrep -f '^[^ ]*zellij attach ${sessionName}'`, {
        stdio: 'ignore',
        timeout: 1500,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Active executor processes per user
   * Key: userId, Value: { process pid, sessionName, branches }
   */
  private executorTerminals: Map<
    UserID,
    {
      sessionName: string;
      activeBranches: Set<BranchID | 'default'>;
      startedAt: Date;
    }
  > = new Map();

  /**
   * Per-user start barrier for the async "no executor exists → spawn one"
   * path.
   *
   * Opening an embedded terminal in React dev can issue two near-simultaneous
   * `terminals.create` calls (the initial attach effect plus the
   * visible/refocus effect; StrictMode/HMR can double this too).
   * Without a reservation, both requests observe `executorTerminals` as
   * empty, both spawn `zellij attach agor-<user> --create`, and both
   * executor sockets consume the same `terminal:tab create` broadcasts.
   * That duplicate attach/create storm is enough to make Zellij 0.44.x
   * panic in its screen/plugin state update path.
   */
  private executorStarting: Map<UserID, Promise<void>> = new Map();

  /**
   * Users whose executor has confirmed (via `terminal:ready`) that its PTY is
   * spawned and zellij is attached, or whose live executor we adopted after a
   * restart. Membership means "the bridge is up right now" — the create()
   * response reports it so the browser can flip to connected without waiting
   * on a channel event that may have raced its own join.
   */
  private readyExecutors: Set<UserID> = new Set();

  /**
   * One-shot settlers waiting for a user's executor to resolve its readiness.
   * Settled with `true` on a ready ack and `false` on executor exit/error or
   * timeout. Used to gate cold-start tab choreography on the real ack instead
   * of a blind boot timer.
   */
  private readyWaiters: Map<UserID, Set<(ready: boolean) => void>> = new Map();

  /**
   * How long the choreography waits for the readiness ack before giving up and
   * SKIPPING it entirely (no blind best-effort fire). Generous relative to a
   * typical zellij boot (~1-3s); a genuinely dead executor surfaces to the
   * browser via its own `terminal:error` ack rather than this timeout.
   */
  private static readonly READY_TIMEOUT_MS = 10_000;

  /**
   * Record executor readiness: unblock any waiters and let a browser already
   * sitting on the channel (cold boot, or a post-reconnect re-announce) leave
   * its "connecting" state.
   */
  handleExecutorReady(userId: UserID): void {
    this.readyExecutors.add(userId);
    this.settleReadyWaiters(userId, true);
    this.app.io?.to(`user/${userId}/terminal`).emit('terminal:ready', { userId });
  }

  /**
   * Relay an executor attach failure to the browser channel so it shows an
   * error instead of hanging on "connecting".
   */
  handleExecutorError(userId: UserID, message?: string): void {
    this.readyExecutors.delete(userId);
    this.settleReadyWaiters(userId, false);
    this.app.io?.to(`user/${userId}/terminal`).emit('terminal:error', { userId, message });
  }

  /** Settle and clear every pending readiness waiter for a user. */
  private settleReadyWaiters(userId: UserID, ready: boolean): void {
    const waiters = this.readyWaiters.get(userId);
    if (!waiters) return;
    this.readyWaiters.delete(userId);
    for (const settle of [...waiters]) settle(ready);
  }

  /**
   * Resolve `true` once the user's executor is ready, or `false` if it exits /
   * errors or hasn't become ready within {@link READY_TIMEOUT_MS}. Resolves
   * immediately when the executor is already known-ready.
   */
  private awaitExecutorReady(userId: UserID): Promise<boolean> {
    if (this.readyExecutors.has(userId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiters = this.readyWaiters.get(userId) ?? new Set();
      const settle = (ready: boolean) => {
        clearTimeout(timer);
        waiters.delete(settle);
        resolve(ready);
      };
      const timer = setTimeout(() => settle(false), TerminalsService.READY_TIMEOUT_MS);
      // Don't keep the process (or a test worker) alive on this fallback timer.
      timer.unref?.();
      waiters.add(settle);
      this.readyWaiters.set(userId, waiters);
    });
  }

  /** Focus a requested tab, avoiding a redundant focus after creating it. */
  private dispatchTabFocus(
    userId: UserID,
    opts: {
      focusTabName?: string;
      skipTabName?: string;
    }
  ): void {
    const { focusTabName, skipTabName } = opts;
    const channel = `user/${userId}/terminal`;
    if (focusTabName && focusTabName !== skipTabName) {
      this.app.io?.to(channel).emit('terminal:tab', {
        userId,
        action: 'focus',
        tabName: focusTabName,
      });
    }
  }

  /**
   * Create or join an executor-based terminal session
   *
   * - Spawns one executor per user (not per terminal)
   * - Uses Feathers channels for I/O
   * - Returns immediately (fire-and-forget spawn)
   *
   * The browser should join the user's terminal channel to receive output.
   */
  private async createExecutorTerminal(
    data: {
      branchId?: BranchID;
      cols?: number;
      rows?: number;
      /** Optional Zellij tab name to focus once the executor is up. */
      focusTabName?: string;
    },
    params?: AuthenticatedParams
  ): Promise<{
    userId: UserID;
    channel: string;
    sessionName: string;
    isNew: boolean;
    branchName?: string;
    ready: boolean;
  }> {
    const userId = params?.user?.user_id as UserID;
    if (!userId) {
      throw new Error('Authentication required for executor terminal');
    }

    const waitForPendingStart = async (): Promise<boolean> => {
      const pending = this.executorStarting.get(userId);
      if (!pending) return false;
      await pending.catch(() => {
        /* the next pass will surface/repair the failed start */
      });
      return true;
    };

    // If another request is already in the cold-start path for this user,
    // wait for it to publish `executorTerminals` and then re-enter. This
    // turns duplicate mount/refocus calls into ordinary warm-path attaches.
    if (await waitForPendingStart()) {
      return this.createExecutorTerminal(data, params);
    }

    // Cold-start adoption: after a daemon restart, `executorTerminals`
    // is empty but the browser's PRIOR `zellij attach agor-<short>`
    // process is still alive (Zellij keeps the session). Without this
    // check, every browser reload post-restart spawns ANOTHER executor
    // → multiple processes listening on `user/<id>/terminal` → every
    // `terminal:tab create` event runs N times → duplicate tabs.
    //
    // Detect any running `zellij attach agor-<sessionName>` and adopt
    // it into the Map so subsequent dispatch reuses the existing
    // executor instead of fork-bombing.
    const expectedSessionName = buildZellijSessionName(userId);
    if (!this.executorTerminals.get(userId)) {
      const adopted = await this.detectExistingExecutor(expectedSessionName);
      if (adopted) {
        console.log(
          `[TerminalsService] adopting existing zellij executor for user ${shortId(userId)} (sessionName=${expectedSessionName})`
        );
        this.executorTerminals.set(userId, {
          sessionName: expectedSessionName,
          activeBranches: new Set(),
          startedAt: new Date(),
        });
        // Deliberately NOT marked ready here. A `pgrep` match means the process
        // exists, not that it has re-established its socket + re-authenticated
        // after the daemon restart — it may be reconnecting or failing auth.
        // Readiness is granted only when the adopted executor actually
        // re-announces `terminal:ready` (handleExecutorReady). Until then the
        // warm path gates its choreography and reports ready:false so the
        // browser waits for the real ack instead of us firing into a dead room.
      }
    }

    // Check if user already has an executor running
    const existing = this.executorTerminals.get(userId);
    if (existing) {
      // Add branch to active set
      const branchKey = data.branchId || 'default';
      existing.activeBranches.add(branchKey);

      // If branch specified, tell executor to create/focus tab
      if (data.branchId) {
        const branch = await this.withTenantDatabase((tenantDb) =>
          new BranchRepository(tenantDb).findById(data.branchId!)
        );
        if (branch) {
          const branchTabName = buildBranchShellTabName(branch);
          const channel = `user/${userId}/terminal`;

          // Gate ALL executor-directed choreography on readiness. For a normal
          // warm reuse (the executor acked ready this daemon session) this
          // resolves immediately; for an adopted post-restart executor it
          // waits until the process actually re-announces `terminal:ready`,
          // so we don't emit tab/redraw commands into an empty/dead room.
          //
          void this.awaitExecutorReady(userId).then(async (isReady) => {
            // Strictly gated: if the ack never arrives (executor errored, or an
            // adopted process never re-announced) we do NOT fire into a dead
            // room. The executor's own terminal:error / the ready:false in the
            // response already keep the browser out of a false "connected".
            if (!isReady) {
              console.warn(
                `[TerminalsService] readiness ack not received for user ${shortId(userId)} — skipping warm choreography`
              );
              return;
            }
            this.app.io?.to(channel).emit('terminal:tab', {
              userId,
              action: 'create',
              tabName: branchTabName,
              cwd: branch.path,
            });
            this.dispatchTabFocus(userId, {
              focusTabName: data.focusTabName,
              skipTabName: branchTabName,
            });
            this.app.io?.to(channel).emit('terminal:redraw', { userId });
          });

          return {
            userId,
            channel,
            sessionName: existing.sessionName,
            isNew: false,
            branchName: branch.name,
            ready: this.readyExecutors.has(userId),
          };
        }
      }

      void this.awaitExecutorReady(userId).then((isReady) => {
        if (isReady) {
          this.app.io?.to(`user/${userId}/terminal`).emit('terminal:redraw', { userId });
        }
      });

      return {
        userId,
        channel: `user/${userId}/terminal`,
        sessionName: existing.sessionName,
        isNew: false,
        ready: this.readyExecutors.has(userId),
      };
    }

    // Re-check the barrier after the async adoption probe above. Two
    // callers can both enter with no pending start, then both await
    // `detectExistingExecutor`; whichever resumes first installs the
    // reservation below, and the later caller must wait/re-enter instead
    // of spawning a second attach process.
    if (await waitForPendingStart()) {
      return this.createExecutorTerminal(data, params);
    }

    let resolveStart!: () => void;
    const startReservation = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    this.executorStarting.set(userId, startReservation);

    try {
      // Resolve Unix user for impersonation
      const config = await loadConfig();
      const unixUserMode = config.execution?.unix_user_mode ?? 'simple';
      const executorUser = config.execution?.executor_unix_user;

      const user = await this.withTenantDatabase((tenantDb) =>
        new UsersRepository(tenantDb).findById(userId)
      );
      const impersonatedUser = user?.unix_username ?? null;

      const impersonationResult = resolveUnixUserForImpersonation({
        mode: unixUserMode as UnixUserMode,
        userUnixUsername: impersonatedUser,
        executorUnixUser: executorUser,
      });

      const finalUnixUser = impersonationResult.unixUser;

      // Validate Unix user exists
      try {
        validateResolvedUnixUser(unixUserMode as UnixUserMode, finalUnixUser);
      } catch (err) {
        if (err instanceof UnixUserNotFoundError) {
          throw new Error(`${(err as UnixUserNotFoundError).message}`);
        }
        throw err;
      }

      // Determine cwd and branch info
      let cwd = os.homedir();
      let branchName: string | undefined;
      let branchTabName: string | undefined;

      const { branch, userEnv, executorEnv } = await this.withTenantDatabase(async (tenantDb) => ({
        branch: data.branchId ? await new BranchRepository(tenantDb).findById(data.branchId) : null,
        userEnv: await resolveUserEnvironment(userId, tenantDb),
        // Get executor process environment (includes system vars). When
        // impersonating, strip HOME/USER/LOGNAME/SHELL so sudo -u can set them.
        executorEnv: await createUserProcessEnvironment(
          userId,
          tenantDb,
          undefined,
          !!finalUnixUser
        ),
      }));
      if (branch) {
        branchName = branch.name;
        branchTabName = buildBranchShellTabName(branch);
        cwd = resolveBranchShellCwd(branch, finalUnixUser);
      }

      // Build Zellij session name
      const sessionName = buildZellijSessionName(userId);

      // Generate session token for executor. Bind the userId into the token
      // (`terminal_user_id`) so the socket layer can scope this executor's
      // terminal:* emits to its own user — a tenant-scoped service token alone
      // can't act for the right user only. See socketio.ts terminal handlers.
      //
      // Terminal executors are long-lived and re-authenticate with THIS SAME
      // token on every reconnect (network blip / daemon restart — the whole
      // point of this feature). The default 5m service-token TTL would expire
      // mid-session and make reconnection fail, so we issue it with a long TTL
      // covering realistic session lifetimes. (A refresh-on-reconnect scheme
      // would be more robust but there's no authenticated channel to fetch a
      // new token on an expired socket; a long TTL fits the current auth model.)
      const daemonUrl = `http://localhost:${config.daemon?.port || 3030}`;
      const sessionToken = generateScopedServiceToken(
        this.app,
        { terminal_user_id: userId },
        TERMINAL_EXECUTOR_TOKEN_TTL
      );

      // File/process work stays outside the tenant database unit of work.
      const envFile = writeEnvFile(userId, userEnv, finalUnixUser);

      // Spawn executor with zellij.attach command
      spawnExecutorFireAndForget(
        {
          command: 'zellij.attach',
          sessionToken,
          daemonUrl,
          params: {
            userId,
            sessionName,
            cwd,
            tabName: branchTabName,
            cols: data.cols || 160,
            rows: data.rows || 40,
            envFile, // Pass env file path for shell to source
          },
        },
        {
          logPrefix: `[TerminalsService.executor ${shortId(userId)}]`,
          asUser: finalUnixUser || undefined,
          env: executorEnv,
          // Clean up map when executor exits (handles crashes too)
          onExit: () => this.handleExecutorExit(userId),
        }
      );

      // Fresh spawn: this executor hasn't acked readiness yet. Drop any stale
      // flag from a prior (now-dead) executor so the gate below waits for the
      // new one's real ack rather than a leftover.
      this.readyExecutors.delete(userId);

      // Track the executor
      this.executorTerminals.set(userId, {
        sessionName,
        activeBranches: new Set([data.branchId || 'default']),
        startedAt: new Date(),
      });

      // Gate focus on the executor's readiness ack so the event is not emitted
      // into an empty room during cold start.
      if (data.focusTabName) {
        const { focusTabName } = data;
        void this.awaitExecutorReady(userId).then((ready) => {
          // Strictly gated on the readiness ack — no blind best-effort fire.
          if (!ready) {
            console.warn(
              `[TerminalsService] readiness ack not received for user ${shortId(userId)} — skipping cold-start tab focus`
            );
            return;
          }
          return this.dispatchTabFocus(userId, { focusTabName });
        });
      }

      return {
        userId,
        channel: `user/${userId}/terminal`,
        sessionName,
        isNew: true,
        branchName,
        ready: false,
      };
    } finally {
      if (this.executorStarting.get(userId) === startReservation) {
        this.executorStarting.delete(userId);
      }
      resolveStart();
    }
  }

  /**
   * Close executor terminal for a branch
   *
   * If this is the last active branch, the executor will exit naturally
   * when the user detaches from Zellij.
   */
  async closeExecutorTerminal(
    data: { branchId?: BranchID },
    params?: AuthenticatedParams
  ): Promise<{ closed: boolean }> {
    const userId = params?.user?.user_id as UserID;
    if (!userId) {
      throw new Error('Authentication required');
    }

    const executor = this.executorTerminals.get(userId);
    if (!executor) {
      return { closed: false };
    }

    const branchKey = data.branchId || 'default';
    executor.activeBranches.delete(branchKey);

    // If no more active branches, mark executor for cleanup
    // The executor will exit when Zellij detaches
    if (executor.activeBranches.size === 0) {
      this.executorTerminals.delete(userId);
    }

    return { closed: true };
  }

  /**
   * Cleanup executor terminals (called on daemon shutdown)
   */
  private cleanupExecutorTerminals(): void {
    // Executors manage their own lifecycle via Zellij
    // Just clear our tracking
    this.executorTerminals.clear();
  }

  /**
   * Handle executor terminal exit (called from channel event)
   */
  handleExecutorExit(userId: UserID): void {
    this.executorTerminals.delete(userId);
    this.readyExecutors.delete(userId);
    // Release any pending readiness waiters as not-ready so they settle
    // immediately instead of hanging until their timeout.
    this.settleReadyWaiters(userId, false);
    console.log(`[TerminalsService] Executor terminal exited for user ${shortId(userId)}`);
  }
}
