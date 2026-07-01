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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeCliSpawn } from '@agor/core/claude-cli';
import {
  createUserProcessEnvironment,
  loadConfig,
  resolveUserEnvironment,
} from '@agor/core/config';
import {
  BranchRepository,
  SessionRepository,
  shortId,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, Branch, BranchID, UserID } from '@agor/core/types';
import {
  getBranchSymlinkPath,
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  UnixUserNotFoundError,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import { hasBranchPermission } from '../utils/branch-authorization.js';
import { canControlCliSession } from '../utils/mcp-token-authorization.js';
import { generateScopedServiceToken, spawnExecutorFireAndForget } from '../utils/spawn-executor.js';
import {
  buildSpawnConfigForSession,
  isClaudeRunningFor,
  writeClaudeCliMcpConfigForSession,
} from './claude-cli-integration.js';

interface CreateTerminalData {
  rows?: number;
  cols?: number;
  branchId?: BranchID; // Branch context for Zellij integration
  /**
   * Optional Zellij tab name to focus once the executor is up. Used by
   * the Claude Code CLI adapter's in-pane EmbeddedTerminal to land on
   * the session's `cli-<short>` tab. Server-only emit (browsers can't
   * publish `terminal:tab` directly).
   */
  focusTabName?: string;
  /**
   * For `claude-code-cli` sessions: the Agor session id whose tab the
   * caller wants opened. When set, the server looks up the session,
   * builds the `claude` spawn config from `cli_state` + session config,
   * and emits a **create-with-command** `terminal:tab` event so the
   * cli-XXX tab exists with `claude` running inside even on cold start.
   *
   * Without this, the cold-start path emits a `focus` event for a tab
   * that doesn't exist yet (since `onCliSessionCreated`'s dispatch lands
   * in an empty room when no executor is connected at session create
   * time) — the user-visible bug is "I created a CLI session and the
   * embedded terminal is just a bash prompt". `ensureCliSessionId`
   * closes that race: the embedded terminal can be the bootstrap
   * trigger for the `claude` REPL itself.
   *
   * Browsers pass the session id; the server is the only thing that
   * knows how to assemble safe argv. The tab name we use is
   * `cli_state.zellij_tab_name` if set (canonical), else derived
   * deterministically from the session id.
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
  }> {
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
        const branchRepo = new BranchRepository(this.db);
        const branch = await branchRepo.findById(data.branchId);
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
      }
    }

    // Resolve `ensureCliSessionId` into a concrete spawn config on the
    // server side. The browser asks "make sure the cli tab for session
    // X exists" — it doesn't know (and shouldn't know) the actual
    // `claude --session-id <X> --add-dir <cwd> --permission-mode <Y>`
    // argv.
    //
    // RBAC: enforced inside `resolveEnsureCliTab` against the
    // **session's actual branch** (not the caller-supplied
    // `data.branchId`, which may differ or be omitted). Without this
    // check a caller could pass an `ensureCliSessionId` for a session
    // whose branch they don't have `'session'` permission on and get
    // the daemon to spawn a CLI tab on their behalf.
    const cliEnsure = await this.resolveEnsureCliTab(
      data.ensureCliSessionId,
      data.branchId,
      params
    );

    return this.createExecutorTerminal(
      {
        branchId: data.branchId,
        cols: data.cols,
        rows: data.rows,
        focusTabName: data.focusTabName ?? cliEnsure?.tabName,
        cliEnsure,
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
   * Opening an embedded Claude CLI terminal in React dev can issue two
   * near-simultaneous `terminals.create` calls (the initial attach effect
   * plus the visible/refocus effect; StrictMode/HMR can double this too).
   * Without a reservation, both requests observe `executorTerminals` as
   * empty, both spawn `zellij attach agor-<user> --create`, and both
   * executor sockets consume the same `terminal:tab create` broadcasts.
   * That duplicate attach/create storm is enough to make Zellij 0.44.x
   * panic in its screen/plugin state update path.
   */
  private executorStarting: Map<UserID, Promise<void>> = new Map();

  /**
   * Create or join an executor-based terminal session
   *
   * - Spawns one executor per user (not per terminal)
   * - Uses Feathers channels for I/O
   * - Returns immediately (fire-and-forget spawn)
   *
   * The browser should join the user's terminal channel to receive output.
   */
  /**
   * Resolve `ensureCliSessionId` into the spawn args we need to emit at
   * the executor — `tabName`, `cwd`, `command`, `commandArgs`. Performs
   * the SessionRepository + branchRepository lookups + builds the
   * `claude` argv via `buildSpawnConfigForSession`/`buildClaudeCliSpawn`.
   *
   * **RBAC**: enforces `'session'`-level `hasBranchPermission` against
   * the **session's actual branch** (not the caller-supplied
   * `claimedBranchId`). Without this, a caller could ask the daemon
   * to ensure-create a CLI tab for a session whose branch they
   * shouldn't access. Also throws `Forbidden` when `claimedBranchId`
   * is supplied AND mismatches the session's branch — defense against
   * "spoof the branch to bypass the upstream branchId check".
   *
   * Returns `null` when the input is undefined, the session doesn't
   * exist, isn't a CLI session, or its branch path can't be resolved.
   * Caller falls back to the prior focus-only behavior in those cases.
   */
  private async resolveEnsureCliTab(
    sessionId: string | undefined,
    claimedBranchId: BranchID | undefined,
    params?: AuthenticatedParams
  ): Promise<{
    tabName: string;
    cwd: string;
    command: string;
    commandArgs: string[];
    sessionId: string;
  } | null> {
    if (!sessionId) return null;
    try {
      const sessionRepo = new SessionRepository(this.db);
      const session = await sessionRepo.findById(sessionId).catch(() => null);
      if (session?.agentic_tool !== 'claude-code-cli') return null;
      // Branch-spoofing guard: when the caller supplied a branchId,
      // it MUST match the session's. Otherwise the upstream RBAC
      // (gated on `data.branchId`) checked a different branch than
      // the one we're about to spawn into.
      if (claimedBranchId && claimedBranchId !== session.branch_id) {
        throw new Forbidden(
          `ensureCliSessionId session belongs to a different branch than the one provided.`
        );
      }
      // Run the same `'session'` permission check the upstream caller
      // did, but against the *session's* branch id. This catches the
      // case where the caller omitted `branchId` entirely (so the
      // upstream check was skipped) and only passed `ensureCliSessionId`.
      if (params?.provider) {
        const config = await loadConfig();
        const rbacEnabled = config.execution?.branch_rbac === true;
        if (rbacEnabled) {
          const callerUserId = params?.user?.user_id as UserID | undefined;
          if (!callerUserId) {
            throw new Forbidden('Authentication required to ensure a CLI tab');
          }
          const branchRepo = new BranchRepository(this.db);
          const wt = await branchRepo.findById(session.branch_id);
          if (!wt) {
            throw new Forbidden(`Session's branch not found: ${session.branch_id}`);
          }
          const isOwner = await branchRepo.isOwner(wt.branch_id, callerUserId);
          const effectivePermission = await branchRepo.resolveUserPermission(wt, callerUserId);
          const allowSuperadmin = config.execution?.allow_superadmin === true;
          const userRole = params?.user?.role as string | undefined;
          if (
            !hasBranchPermission(
              wt,
              callerUserId,
              isOwner,
              'session',
              userRole,
              allowSuperadmin,
              effectivePermission
            )
          ) {
            throw new Forbidden(
              `You need 'session' permission on the session's branch to ensure its CLI tab.`
            );
          }
        }
      }
      if (
        params?.provider &&
        !canControlCliSession({
          callerUserId: params.user?.user_id,
          callerRole: params.user?.role,
          sessionCreatedBy: session.created_by,
        })
      ) {
        throw new Forbidden('You can only ensure CLI tabs for Claude CLI sessions you created.');
      }
      const branchRepo = new BranchRepository(this.db);
      const branch = await branchRepo.findById(session.branch_id);
      if (!branch?.path) return null;
      const mcpConfigPath = await writeClaudeCliMcpConfigForSession(this.app, session, {
        actor: params?.user ?? null,
      });
      const spawnCfg = buildSpawnConfigForSession(session, branch.path, { mcpConfigPath });
      const built = buildClaudeCliSpawn(spawnCfg);
      const tabName =
        session.cli_state?.zellij_tab_name ??
        spawnCfg.displayName ??
        `cli-${shortId(session.session_id)}`;
      return {
        tabName,
        cwd: branch.path,
        command: built.bin,
        commandArgs: built.args,
        sessionId: session.session_id,
      };
    } catch (err) {
      // Re-throw Forbidden so the caller sees the auth failure — only
      // swallow unexpected errors (DB hiccup etc.) into a graceful
      // "no ensure-create" fallback.
      if (err instanceof Forbidden) throw err;
      console.warn('[TerminalsService] resolveEnsureCliTab failed', err);
      return null;
    }
  }

  private async createExecutorTerminal(
    data: {
      branchId?: BranchID;
      cols?: number;
      rows?: number;
      /**
       * Optional Zellij tab name to focus once the executor is up. Used by
       * the Claude Code CLI adapter's in-pane EmbeddedTerminal to land on
       * the session's `cli-<short>` tab rather than the branch default.
       *
       * The focus emit happens server-side because browser sockets are not
       * allowed to publish on `terminal:tab` (only service tokens may).
       */
      focusTabName?: string;
      /**
       * Resolved CLI spawn for `ensureCliSessionId`. When set, both the
       * warm-executor and cold-start paths emit a **create-with-command**
       * `terminal:tab` event so the cli-XXX tab exists with `claude`
       * running inside, instead of a plain `focus` that no-ops on a tab
       * that was never spawned (the original cold-start race). The
       * executor's `handleTabAction('create')` is already idempotent
       * (auto-converts to focus when the tab exists), so we can fire
       * this on every call without worrying about double-spawn.
       */
      cliEnsure?: {
        tabName: string;
        cwd: string;
        command: string;
        commandArgs: string[];
        /**
         * Agor session id — used to pgrep for a live `claude` process
         * bound to it. When the process is dead (Ctrl-D, kill -9, etc.)
         * we emit `forceRecreate: true` so the executor closes the
         * stale tab + respawns claude fresh. When alive, we emit a
         * plain `focus` and preserve scrollback.
         */
        sessionId: string;
      } | null;
    },
    params?: AuthenticatedParams
  ): Promise<{
    userId: UserID;
    channel: string;
    sessionName: string;
    isNew: boolean;
    branchName?: string;
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
    const expectedSessionName = `agor-${shortId(userId)}`;
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
        const branchRepo = new BranchRepository(this.db);
        const branch = await branchRepo.findById(data.branchId);
        if (branch) {
          const branchTabName = buildBranchShellTabName(branch);
          // Emit tab command via channel - executor will handle it
          this.app.io?.to(`user/${userId}/terminal`).emit('terminal:tab', {
            userId,
            action: 'create',
            tabName: branchTabName,
            cwd: branch.path,
          });

          // Ensure-create the CLI tab when an `ensureCliSessionId` was
          // supplied.
          //
          // Server-side claude liveness check decides the action:
          //   - `claude` alive ⇒ `focus` (preserves scrollback)
          //   - `claude` dead  ⇒ `create` + `forceRecreate: true`
          //     (closes every stale duplicate of the tab name, then
          //     spawns fresh with the layout-file claude argv)
          //
          // Without this branching, reopening a session whose
          // foreground claude exited (Ctrl-D, kill -9, post-restart-
          // before-watchdog-fires) left the user staring at a bash
          // prompt — the executor's default "tab exists ⇒ focus"
          // auto-converse focused the stale tab instead of respawning.
          //
          // Falls back to the old plain-focus behavior when the caller
          // provided a `focusTabName` without an `ensureCliSessionId`.
          if (data.cliEnsure && data.cliEnsure.tabName !== branchTabName) {
            const ensure = data.cliEnsure;
            const alive = await isClaudeRunningFor(
              ensure.sessionId as unknown as import('@agor/core/types').SessionID
            );
            setTimeout(() => {
              if (alive) {
                this.app.io?.to(`user/${userId}/terminal`).emit('terminal:tab', {
                  userId,
                  action: 'focus',
                  tabName: ensure.tabName,
                });
              } else {
                this.app.io?.to(`user/${userId}/terminal`).emit('terminal:tab', {
                  userId,
                  action: 'create',
                  tabName: ensure.tabName,
                  cwd: ensure.cwd,
                  command: ensure.command,
                  commandArgs: ensure.commandArgs,
                  forceRecreate: true,
                });
              }
            }, 300);
          } else if (data.focusTabName && data.focusTabName !== branchTabName) {
            setTimeout(() => {
              this.app.io?.to(`user/${userId}/terminal`).emit('terminal:tab', {
                userId,
                action: 'focus',
                tabName: data.focusTabName,
              });
            }, 300);
          }

          // Request screen redraw after a short delay to let client join channel first
          setTimeout(() => {
            this.app.io?.to(`user/${userId}/terminal`).emit('terminal:redraw', { userId });
          }, 200);

          return {
            userId,
            channel: `user/${userId}/terminal`,
            sessionName: existing.sessionName,
            isNew: false,
            branchName: branch.name,
          };
        }
      }

      // Request screen redraw after a short delay to let client join channel first
      setTimeout(() => {
        this.app.io?.to(`user/${userId}/terminal`).emit('terminal:redraw', { userId });
      }, 200);

      return {
        userId,
        channel: `user/${userId}/terminal`,
        sessionName: existing.sessionName,
        isNew: false,
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

      let impersonatedUser: string | null = null;
      const usersRepo = new UsersRepository(this.db);
      try {
        const user = await usersRepo.findById(userId);
        if (user?.unix_username) {
          impersonatedUser = user.unix_username;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to load user ${userId}:`, error);
      }

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

      if (data.branchId) {
        const branchRepo = new BranchRepository(this.db);
        const branch = await branchRepo.findById(data.branchId);
        if (branch) {
          branchName = branch.name;
          branchTabName = buildBranchShellTabName(branch);
          cwd = resolveBranchShellCwd(branch, finalUnixUser);
        }
      }

      // Build Zellij session name
      const userSessionSuffix = shortId(userId);
      const sessionName = `agor-${userSessionSuffix}`;

      // Generate session token for executor
      const daemonUrl = `http://localhost:${config.daemon?.port || 3030}`;
      const sessionToken = generateScopedServiceToken(this.app, params);

      // Get user environment and write env file for shell sourcing
      const userEnv = await resolveUserEnvironment(userId, this.db);
      const envFile = writeEnvFile(userId, userEnv, finalUnixUser);

      // Get executor process environment (includes system vars)
      // When impersonating, strip HOME/USER/LOGNAME/SHELL so sudo -u can set them
      const executorEnv = await createUserProcessEnvironment(
        userId,
        this.db,
        undefined,
        !!finalUnixUser
      );

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

      // Track the executor
      this.executorTerminals.set(userId, {
        sessionName,
        activeBranches: new Set([data.branchId || 'default']),
        startedAt: new Date(),
      });

      // Cold-start path: the executor hasn't yet attached to its Feathers
      // channel, so the `onCliSessionCreated` dispatch (if any) landed in
      // an empty room and was dropped. Re-emit after the executor boots
      // (~1.5s). Same liveness branching as the warm path — `claude`
      // alive ⇒ focus, dead ⇒ forceRecreate (close any stale tab from
      // an earlier daemon instance, then spawn fresh).
      if (data.cliEnsure) {
        const ensure = data.cliEnsure;
        const alive = await isClaudeRunningFor(
          ensure.sessionId as unknown as import('@agor/core/types').SessionID
        );
        setTimeout(() => {
          if (alive) {
            this.app.io?.to(`user/${userId}/terminal`).emit('terminal:tab', {
              userId,
              action: 'focus',
              tabName: ensure.tabName,
            });
          } else {
            this.app.io?.to(`user/${userId}/terminal`).emit('terminal:tab', {
              userId,
              action: 'create',
              tabName: ensure.tabName,
              cwd: ensure.cwd,
              command: ensure.command,
              commandArgs: ensure.commandArgs,
              forceRecreate: true,
            });
          }
        }, 1500);
      } else if (data.focusTabName) {
        setTimeout(() => {
          this.app.io?.to(`user/${userId}/terminal`).emit('terminal:tab', {
            userId,
            action: 'focus',
            tabName: data.focusTabName,
          });
        }, 1500);
      }

      return {
        userId,
        channel: `user/${userId}/terminal`,
        sessionName,
        isNew: true,
        branchName,
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
    console.log(`[TerminalsService] Executor terminal exited for user ${shortId(userId)}`);
  }
}
