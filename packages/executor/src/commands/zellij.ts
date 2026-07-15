/**
 * Zellij Command Handlers for Executor
 *
 * These handlers manage Zellij terminal sessions for users.
 *
 * Architecture:
 * - One executor per user (spawned when user opens first terminal)
 * - Executor owns a single PTY running `zellij attach`
 * - Zellij manages multiple tabs (one per branch)
 * - PTY I/O streams over Feathers channel: user/${userId}/terminal
 *
 * Lifecycle:
 * 1. User opens terminal modal → daemon spawns executor with zellij.attach
 * 2. Executor connects to daemon, joins user's terminal channel
 * 3. Executor spawns PTY with zellij attach
 * 4. PTY output → channel → browser; browser input → channel → PTY
 * 5. User opens another branch → daemon sends zellij.tab command
 * 6. User closes all terminals → daemon kills executor
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IPty } from 'node-pty';
import type { ExecutorResult, ZellijAttachPayload, ZellijTabPayload } from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

/**
 * Global PTY process - only one per executor instance
 * (executor is per-user, so one PTY per user)
 */
let ptyProcess: IPty | null = null;
let feathersClient: AgorClient | null = null;
let _currentUserId: string | null = null;
let currentPtyCols = 160;
let currentPtyRows = 40;

/** Longest a buffered chunk may wait before it is emitted. */
const OUTPUT_FLUSH_INTERVAL_MS = 16;
/** Flush early once the buffer reaches this size, regardless of the timer. */
const OUTPUT_FLUSH_MAX_BYTES = 64 * 1024;

export interface OutputCoalescer {
  push(chunk: string): void;
  flush(): void;
  dispose(): void;
}

/**
 * Coalesce rapid PTY output chunks into fewer, larger emits.
 *
 * node-pty's `onData` fires once per OS-level read; under heavy output
 * (builds, `yes`, zellij full-screen redraws) that is hundreds of tiny
 * callbacks per second, and emitting one Socket.IO frame per callback is
 * what makes the browser terminal janky. We accumulate into a buffer and
 * emit it as a single frame, flushing on whichever comes first:
 *
 *   - `setImmediate`: collapses every chunk that arrives before the event
 *     loop next yields into one emit (the common heavy-output case), while
 *     keeping interactive latency to a single tick.
 *   - a `intervalMs` timer: caps how long a steady stream is held so output
 *     still feels live.
 *   - a `maxBytes` size cap: a runaway stream must not grow the buffer
 *     unbounded while it waits for the timer.
 *
 * `intervalMs`/`maxBytes` are injectable for unit testing.
 */
export function createOutputCoalescer(
  emit: (data: string) => void,
  intervalMs: number = OUTPUT_FLUSH_INTERVAL_MS,
  maxBytes: number = OUTPUT_FLUSH_MAX_BYTES
): OutputCoalescer {
  let buffer = '';
  // Tracked separately from `buffer.length`: that counts UTF-16 code units,
  // but the cap is about the encoded UTF-8 payload we hand to Socket.IO, so
  // multi-byte output (box-drawing, emoji, non-Latin) must count real bytes.
  let bufferedBytes = 0;
  let immediate: ReturnType<typeof setImmediate> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearScheduled() {
    if (immediate) {
      clearImmediate(immediate);
      immediate = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush() {
    clearScheduled();
    if (buffer.length === 0) return;
    const data = buffer;
    buffer = '';
    bufferedBytes = 0;
    emit(data);
  }

  function push(chunk: string) {
    if (chunk.length === 0) return;
    buffer += chunk;
    bufferedBytes += Buffer.byteLength(chunk, 'utf8');
    if (bufferedBytes >= maxBytes) {
      flush();
      return;
    }
    if (!immediate) immediate = setImmediate(flush);
    if (!timer) timer = setTimeout(flush, intervalMs);
  }

  return { push, flush, dispose: flush };
}

/**
 * Handle zellij.attach command
 *
 * Spawns PTY with zellij attach and streams I/O over Feathers channel.
 * This is a long-running command - executor stays alive until terminated.
 */
export async function handleZellijAttach(
  payload: ZellijAttachPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { userId, sessionName, cwd, tabName, cols, rows, envFile } = payload.params;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'zellij.attach',
        userId,
        sessionName,
        cwd,
        tabName,
        cols,
        rows,
      },
    };
  }

  // Only one PTY per executor
  if (ptyProcess) {
    return {
      success: false,
      error: {
        code: 'PTY_ALREADY_RUNNING',
        message: 'Zellij PTY is already running in this executor',
      },
    };
  }

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    feathersClient = await createExecutorClient(daemonUrl, payload.sessionToken);
    _currentUserId = userId;

    console.log(`[zellij.attach] Connected to daemon, joining channel user/${userId}/terminal`);

    // Join the user's terminal channel
    // The daemon will route terminal events through this channel
    const socket = feathersClient.io;
    socket.emit('join', `user/${userId}/terminal`);

    // Handle socket disconnect gracefully
    // This happens when daemon restarts (watch mode) - just exit cleanly
    // A new executor will be spawned when user reopens terminal
    socket.on('disconnect', (reason: string) => {
      console.log(`[zellij.attach] Socket disconnected: ${reason}`);
      // Clean up and exit gracefully instead of crashing
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
      }
      process.exit(0);
    });

    // Import node-pty dynamically (native module)
    // Using upstream microsoft/node-pty (no engines cap, supports Node 24/25)
    const nodePty: typeof import('node-pty') = await import('node-pty');

    // Build zellij command - config path added after fs/actualHome are defined below
    const zellijArgs = ['attach', sessionName, '--create'];

    // Build clean environment for Zellij
    // CRITICAL: Strip existing Zellij env vars to prevent "attach to current session" error
    // This happens when executor is spawned from within a Zellij session (legacy terminal mode)
    const cleanEnv = { ...process.env };
    delete cleanEnv.ZELLIJ;
    delete cleanEnv.ZELLIJ_SESSION_NAME;
    delete cleanEnv.ZELLIJ_PANE_ID;

    // Get actual home directory and shell for current user from passwd
    // os.homedir() doesn't work correctly with sudo impersonation - it returns the original user's home
    // We must use getent passwd to get the correct values for the impersonated user
    const { execSync } = await import('node:child_process');

    let actualHome = '/tmp'; // Fallback
    let userShell = '/bin/bash'; // Fallback
    try {
      const passwdEntry = execSync(`getent passwd $(whoami)`, { encoding: 'utf-8' }).trim();
      const fields = passwdEntry.split(':');
      // passwd format: name:password:uid:gid:gecos:home:shell
      if (fields.length >= 6 && fields[5]) {
        actualHome = fields[5];
      }
      if (fields.length >= 7 && fields[6]) {
        userShell = fields[6];
      }
    } catch (err) {
      console.error(`[zellij.attach] Failed to get user info from passwd:`, err);
    }
    console.log(`[zellij.attach] User home: ${actualHome}, shell: ${userShell}`);

    // Ensure Zellij cache directory exists - useradd -m creates home but not .cache/zellij
    // Zellij needs this for plugin data, session info, and session serialization
    const zellijCacheDir = `${actualHome}/.cache/zellij`;
    if (!fs.existsSync(zellijCacheDir)) {
      console.log(`[zellij.attach] Creating Zellij cache directory: ${zellijCacheDir}`);
      fs.mkdirSync(zellijCacheDir, { recursive: true });
    }

    // Zellij will use ~/.config/zellij/config.kdl by default
    // The docker entrypoint copies Agor's default config there on user creation
    // Users can customize their config as needed

    console.log(`[zellij.attach] Spawning PTY: zellij ${zellijArgs.join(' ')}`);
    console.log(`[zellij.attach] CWD: ${cwd}, Size: ${cols}x${rows}`);

    // Spawn PTY with zellij
    const pty = nodePty.spawn('zellij', zellijArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: {
        ...cleanEnv,
        TERM: 'xterm-256color',
        SHELL: userShell, // Explicit shell - Zellij needs this to spawn terminal panes
        HOME: actualHome, // Ensure Zellij uses correct home for cache/config
        XDG_CACHE_HOME: `${actualHome}/.cache`, // Explicit cache dir
        XDG_CONFIG_HOME: `${actualHome}/.config`, // Explicit config dir
      },
    });

    ptyProcess = pty;
    currentSessionName = sessionName; // Store for tab management
    currentPtyCols = cols || 80;
    currentPtyRows = rows || 24;

    console.log(`[zellij.attach] PTY spawned, PID: ${pty.pid}`);

    // Stream PTY output to channel, coalesced into fewer/larger frames so
    // heavy output doesn't drown the browser terminal in tiny writes.
    const outputCoalescer = createOutputCoalescer((data) => {
      socket.emit('terminal:output', { userId, data });
    });
    pty.onData((chunk) => outputCoalescer.push(chunk));

    // Handle PTY exit
    pty.onExit(({ exitCode, signal }) => {
      console.log(`[zellij.attach] PTY exited: code=${exitCode}, signal=${signal}`);
      // Emit any buffered tail before the socket tears down.
      outputCoalescer.dispose();
      ptyProcess = null;

      // Notify daemon that terminal ended
      socket.emit('terminal:exit', {
        userId,
        exitCode,
        signal,
      });

      // Cleanup and exit
      if (feathersClient) {
        feathersClient.io.disconnect();
        feathersClient = null;
      }

      process.exit(exitCode || 0);
    });

    // Listen for input from browser via channel
    socket.on('terminal:input', (data: { userId: string; input: string }) => {
      if (data.userId === userId && ptyProcess) {
        ptyProcess.write(data.input);
      }
    });

    // Listen for resize events
    socket.on('terminal:resize', (data: { userId: string; cols: number; rows: number }) => {
      if (data.userId === userId && ptyProcess) {
        currentPtyCols = data.cols;
        currentPtyRows = data.rows;
        ptyProcess.resize(data.cols, data.rows);
      }
    });

    // Listen for tab commands (from daemon when user switches branches
    // OR when a `claude-code-cli` session is created — the daemon passes
    // `command` + `commandArgs` so the new tab spawns the `claude` binary
    // directly into its foreground process).
    socket.on(
      'terminal:tab',
      async (data: {
        action: string;
        tabName: string;
        cwd?: string;
        command?: string;
        commandArgs?: string[];
        /** Force-recreate semantics for `create`: closes every existing
         *  tab named `tabName` before spawning a fresh one. Used by
         *  /sessions/:id/restart-cli and by the daemon's ensure-create
         *  path when it detected the in-tab claude was dead. */
        forceRecreate?: boolean;
      }) => {
        try {
          await handleTabAction(
            data.action,
            data.tabName,
            data.cwd,
            data.command,
            data.commandArgs,
            data.forceRecreate
          );
        } catch (err) {
          // handleTabAction throws on focus/create-without-command
          // failure; the socket handler must catch it or Node will
          // treat it as an unhandled rejection and tear down the
          // executor. We log + drop — the next ensure-create / Restart
          // re-attempts naturally.
          console.warn(
            `[zellij.tab] handleTabAction(${data.action} ${data.tabName}) failed:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    );

    // Listen for redraw requests (when client reconnects)
    // Trigger resize to force Zellij to redraw via SIGWINCH
    socket.on('terminal:redraw', (data: { userId: string }) => {
      if (data.userId === userId && ptyProcess) {
        ptyProcess.resize(currentPtyCols, currentPtyRows);
      }
    });

    // Create initial tab if specified. Retried because `zellij attach
    // --create` boots the session asynchronously — the first
    // `action new-tab` after a fast attach can race with the server
    // setup and get back "There is no active session!" before the
    // session is registered. Without retry + catch, that error
    // propagates as an unhandled promise rejection and crashes the
    // executor (Node 22+ behavior).
    if (tabName) {
      void (async () => {
        await new Promise((r) => setTimeout(r, 500));
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await handleTabAction('create', tabName, cwd);
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/no active session/i.test(msg) && attempt < 4) {
              console.log(
                `[zellij.attach] Initial new-tab raced zellij boot (attempt ${attempt + 1}) — retrying in 300ms`
              );
              await new Promise((r) => setTimeout(r, 300));
              continue;
            }
            console.warn('[zellij.attach] Initial new-tab failed (giving up):', msg);
            return;
          }
        }
      })();
    }

    // Source env file after Zellij initializes (user env vars like API keys)
    if (envFile && ptyProcess) {
      // Wait for shell to be ready, then source env file
      setTimeout(() => {
        if (ptyProcess) {
          // Source the env file silently (suppress output, ignore errors if file doesn't exist)
          const sourceCmd = `[ -f '${envFile}' ] && source '${envFile}' 2>/dev/null; clear\r`;
          ptyProcess.write(sourceCmd);
          console.log(`[zellij.attach] Sourced env file: ${envFile}`);
        }
      }, 800); // Wait longer than tab creation to ensure shell is ready
    }

    // Return success - executor stays running until PTY exits
    return {
      success: true,
      data: {
        pid: pty.pid,
        sessionName,
        userId,
        channel: `user/${userId}/terminal`,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[zellij.attach] Failed:', errorMessage);

    // Cleanup on error
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
    if (feathersClient) {
      feathersClient.io.disconnect();
      feathersClient = null;
    }

    return {
      success: false,
      error: {
        code: 'ZELLIJ_ATTACH_FAILED',
        message: errorMessage,
      },
    };
  }
}

/**
 * Handle zellij.tab command
 *
 * Creates or focuses a tab in the existing Zellij session.
 * This is sent to a running executor (not a new spawn).
 */
export async function handleZellijTab(
  payload: ZellijTabPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { action, tabName, cwd, command, commandArgs, forceRecreate } = payload.params;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'zellij.tab',
        action,
        tabName,
        cwd,
        tabCommand: command,
        tabCommandArgs: commandArgs,
      },
    };
  }

  // Must have a running PTY
  if (!ptyProcess) {
    return {
      success: false,
      error: {
        code: 'NO_PTY_RUNNING',
        message: 'No Zellij PTY is running in this executor',
      },
    };
  }

  try {
    await handleTabAction(action, tabName, cwd, command, commandArgs, forceRecreate);

    return {
      success: true,
      data: {
        action,
        tabName,
        spawnedCommand: command,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: {
        code: 'ZELLIJ_TAB_FAILED',
        message: errorMessage,
      },
    };
  }
}

/**
 * Current Zellij session name (set when attach starts)
 */
let currentSessionName: string | null = null;

/**
 * Query existing tab names from Zellij session
 */
async function queryTabNames(): Promise<string[]> {
  if (!currentSessionName) {
    console.warn('[zellij.tab] No session name set, cannot query tabs');
    return [];
  }

  const sessionName = currentSessionName; // Capture for closure
  return new Promise((resolve) => {
    // Must specify --session to query the correct Zellij session
    const proc = spawn('zellij', ['--session', sessionName, 'action', 'query-tab-names'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      proc.kill();
      console.warn('[zellij.tab] query-tab-names timed out');
      resolve([]);
    }, 3000);

    proc.on('exit', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        const tabs = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        resolve(tabs);
      } else {
        // On error, return empty - we'll try to create the tab
        resolve([]);
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve([]);
    });
  });
}

/**
 * Execute a zellij action command
 *
 * Uses `zellij action` CLI to control the running session.
 * For 'create' action, checks if tab exists first and focuses instead.
 *
 * When `command` is supplied on a `create` action, the new tab spawns
 * the named binary instead of the user's default shell. This is how the
 * Claude Code CLI adapter drops the user into an interactive `claude`
 * REPL inside a Zellij pane — see
 * docs/internal/claude-code-cli-integration-analysis-2026-05-14.md §
 * "Spawn shape".
 */
/**
 * Run one `zellij --session <X> action <args...>` invocation.
 * Returns exit code + stderr so callers can branch on success/failure
 * without re-implementing the spawn boilerplate. 5s timeout — every
 * zellij action we issue should be sub-second; longer means the
 * server is wedged and we'd rather time out than hang the executor's
 * tab-event loop.
 */
function runZellij(
  sessionName: string,
  actionArgs: string[]
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const args = ['--session', sessionName, 'action', ...actionArgs];
    console.log(`[zellij.tab] Executing: zellij ${args.join(' ')}`);
    const proc = spawn('zellij', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
      console.error(`[zellij.tab] zellij action timed out: ${actionArgs.join(' ')}`);
      resolve({ code: null, stderr: `timeout: ${stderr}` });
    }, 5000);
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ code: null, stderr: err.message });
    });
  });
}

/**
 * Close EVERY tab matching `tabName`. Zellij's `close-tab` only closes
 * the currently-focused tab, so for duplicates (which happen when
 * multiple executors race on `new-tab` — see CLAUDE.md's "Cold-start
 * race" notes) we navigate-then-close in a loop.
 *
 * **Critical guard**: count matches upfront and bound the loop by
 * that count. Earlier "loop until go-to-tab-name errors" semantics
 * blew up because `zellij action go-to-tab-name <missing>` does NOT
 * always return non-zero — it can silently no-op, leaving focus on
 * whatever tab was current. The subsequent `close-tab` then kills
 * the WRONG tab, and the loop keeps killing tabs until the session
 * is empty (zellij with no tabs auto-exits — the whole executor
 * dies). We saw this in the wild on the Restart path against a
 * session that had several `cli-XXX` duplicates plus unrelated tabs.
 *
 * Re-query between iterations so concurrent activity (e.g. a
 * sibling executor closing tabs simultaneously) doesn't confuse our
 * count.
 */
async function closeAllTabsNamed(sessionName: string, tabName: string): Promise<void> {
  // Cap by initial count so we never close more tabs than existed at
  // start. Re-checked each iteration in case parallel activity pruned
  // the list under us.
  const initialTabs = await queryTabNames();
  const initialMatches = initialTabs.filter((t) => t === tabName).length;
  if (initialMatches === 0) {
    console.log(`[zellij.tab] No tabs to close for "${tabName}" — already gone`);
    return;
  }
  let closed = 0;
  for (let i = 0; i < initialMatches; i++) {
    // Verify a matching tab still exists before navigating + closing.
    // Guards against the "go-to-tab-name silently no-ops on missing
    // name → close-tab kills the wrong tab" failure mode.
    const currentTabs = await queryTabNames();
    if (!currentTabs.includes(tabName)) {
      break;
    }
    const focusResult = await runZellij(sessionName, ['go-to-tab-name', tabName]);
    if (focusResult.code !== 0) {
      break;
    }
    const closeResult = await runZellij(sessionName, ['close-tab']);
    if (closeResult.code !== 0) {
      console.warn(`[zellij.tab] close-tab failed for "${tabName}": ${closeResult.stderr}`);
      break;
    }
    closed += 1;
  }
  console.log(`[zellij.tab] Closed ${closed} of ${initialMatches} tab(s) named "${tabName}"`);
}

/**
 * Run `new-tab` with the per-tab KDL layout file that spawns `command`
 * as the tab's foreground pane. Caller is responsible for ensuring no
 * stale duplicate tab exists when forceRecreate semantics are required.
 */
async function createTabWithLayout(
  sessionName: string,
  tabName: string,
  cwd: string | undefined,
  command: string,
  commandArgs: string[]
): Promise<{ code: number | null; stderr: string }> {
  const layoutPath = writeClaudeLayoutFile(tabName, cwd, command, commandArgs);
  const actionArgs = ['new-tab', '--name', tabName, '--layout', layoutPath];
  if (cwd) {
    actionArgs.splice(3, 0, '--cwd', cwd);
  }
  return runZellij(sessionName, actionArgs);
}

async function handleTabAction(
  action: string,
  tabName: string,
  cwd?: string,
  command?: string,
  commandArgs?: string[],
  forceRecreate?: boolean
): Promise<void> {
  if (!currentSessionName) {
    console.error('[zellij.tab] No session name set, cannot perform tab action');
    return;
  }
  const sessionName = currentSessionName;

  // ── close ───────────────────────────────────────────────────────────
  // Close ALL matching tabs. Idempotent: silent no-op if tab is absent.
  // Multi-iteration covers the "duplicate tabs from racing executors"
  // case — the previous single-shot close left siblings behind, and
  // subsequent `create` would auto-converse to focus the stale sibling
  // instead of spawning fresh.
  if (action === 'close') {
    await closeAllTabsNamed(sessionName, tabName);
    return;
  }

  // ── focus ───────────────────────────────────────────────────────────
  if (action === 'focus') {
    const result = await runZellij(sessionName, ['go-to-tab-name', tabName]);
    if (result.code !== 0) {
      console.warn(`[zellij.tab] focus "${tabName}" failed: ${result.stderr}`);
      throw new Error(`zellij action failed with code ${result.code}: ${result.stderr}`);
    }
    console.log(`[zellij.tab] Tab action succeeded: focus ${tabName}`);
    return;
  }

  // ── create (with or without forceRecreate) ──────────────────────────
  if (action !== 'create') {
    throw new Error(`Unknown tab action: ${action}`);
  }

  if (forceRecreate) {
    // Caller (e.g. /sessions/:id/restart-cli, or the ensure-create
    // path when claude is dead) explicitly wants a fresh tab even if
    // a stale-named one already exists. Close every matching tab
    // first, then proceed to new-tab.
    console.log(`[zellij.tab] forceRecreate=true for "${tabName}" — closing existing first`);
    await closeAllTabsNamed(sessionName, tabName);
  } else {
    // Default: if the tab already exists, treat the create as a
    // "land on this tab" hint and just focus it. Preserves scrollback
    // for the common reload case where the tab + its foreground
    // process are both still healthy.
    const existingTabs = await queryTabNames();
    if (existingTabs.includes(tabName)) {
      console.log(`[zellij.tab] Tab "${tabName}" already exists, focusing instead of creating`);
      const result = await runZellij(sessionName, ['go-to-tab-name', tabName]);
      if (result.code !== 0) {
        console.warn(`[zellij.tab] focus-on-existing failed for "${tabName}": ${result.stderr}`);
      }
      return;
    }
  }

  // Fresh new-tab. With `command`, Zellij's `action new-tab` doesn't
  // accept `--command` directly — we materialize a per-tab KDL layout
  // file declaring one pane that runs it (see writeClaudeLayoutFile).
  if (command) {
    const result = await createTabWithLayout(sessionName, tabName, cwd, command, commandArgs ?? []);
    if (result.code !== 0) {
      throw new Error(`zellij new-tab failed with code ${result.code}: ${result.stderr}`);
    }
    console.log(`[zellij.tab] Tab action succeeded: create ${tabName} (with command)`);
    return;
  }

  const actionArgs = ['new-tab', '--name', tabName];
  if (cwd) actionArgs.push('--cwd', cwd);
  const result = await runZellij(sessionName, actionArgs);
  if (result.code !== 0) {
    throw new Error(`zellij new-tab failed with code ${result.code}: ${result.stderr}`);
  }
  console.log(`[zellij.tab] Tab action succeeded: create ${tabName}`);
}

/**
 * Materialize a Zellij KDL layout file describing one pane that runs a
 * specific binary with the given argv. Used by the Claude Code CLI
 * adapter to spawn `claude` into a freshly-created tab.
 *
 * Layout shape (KDL):
 *
 *   layout {
 *     pane command="claude" cwd="..." {
 *       args "--session-id" "..." "-n" "cli-..." "--permission-mode" "acceptEdits" ...
 *     }
 *   }
 *
 * Returns the absolute path of the written file. The file is left on disk
 * after Zellij parses it — Zellij reads it synchronously during the
 * `action new-tab --layout <file>` call, so cleanup is optional. We keep
 * it under `/tmp/agor-zellij-layouts/` for easy diagnosis if a spawn
 * misbehaves.
 */
function writeClaudeLayoutFile(
  tabName: string,
  cwd: string | undefined,
  command: string,
  commandArgs: string[]
): string {
  const dir = '/tmp/agor-zellij-layouts';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = path.join(dir, `${tabName}-${Date.now()}.kdl`);
  // KDL string-escaping: backslashes and double-quotes only. Each argv
  // element becomes a separate quoted token inside `args`. Named
  // `quoteKdl` (not `escape`) to avoid shadowing the global
  // `escape()` URL-encoder.
  const quoteKdl = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const argsLine =
    commandArgs.length > 0 ? `        args ${commandArgs.map(quoteKdl).join(' ')}\n` : '';
  const cwdAttr = cwd ? ` cwd=${quoteKdl(cwd)}` : '';
  const layout = `layout {
    pane command=${quoteKdl(command)}${cwdAttr} {
${argsLine}    }
}
`;
  fs.writeFileSync(filePath, layout, { mode: 0o600 });
  return filePath;
}

/**
 * Cleanup function - called when executor is shutting down
 */
export function cleanupZellij(): void {
  if (ptyProcess) {
    console.log('[zellij] Killing PTY process');
    ptyProcess.kill();
    ptyProcess = null;
  }
  if (feathersClient) {
    feathersClient.io.disconnect();
    feathersClient = null;
  }
  currentSessionName = null;
}
