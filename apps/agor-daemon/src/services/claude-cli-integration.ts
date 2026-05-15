/**
 * Wires the Claude Code CLI watcher into the sessions service lifecycle.
 *
 * The watcher itself (`claude-cli-watcher.ts`) is decoupled from Feathers —
 * it takes a `persister` and a `sink` as constructor args. This file is the
 * "wiring": it builds those callbacks against the live Feathers app, manages
 * the watcher registry singleton, and exposes hooks the sessions service
 * calls at create / startup / teardown.
 *
 * Architecture:
 *   sessions service ──(session created)──> integration.onSessionCreated()
 *                                            │
 *                                            ├─ resolve homeDir for owner
 *                                            ├─ compute slug + jsonl path
 *                                            └─ registry.register({...})
 *                                                  │
 *                                                  └─ ClaudeCliWatcher starts
 *                                                       │
 *                                                       ├─ fs.watch event
 *                                                       ├─ translator emits
 *                                                       └─ sink writes DB
 *
 * v1 scope (this file):
 *   - persister: patches `sessions.data.cli_state` via SessionRepository
 *   - sink: structured console log (the real Messages/Tasks writes come
 *     in a follow-up — keeping the watcher useful as a soft-launch /
 *     telemetry surface even before UI lands)
 *   - onDaemonStartup: scans for in-flight `claude-code-cli` sessions and
 *     re-instantiates watchers from persisted offset
 *
 * Out of scope here (will land with UI integration):
 *   - MessagesService.create from translated events
 *   - TasksService.patch on assistant turn end
 *   - Subagent JSONL discovery
 */

import * as fs from 'node:fs';
import os from 'node:os';
import {
  buildClaudeCliSpawn,
  type ClaudeCliPermissionMode,
  type ClaudeCliSpawnConfig,
  claudeSessionJsonlPath,
  slugForCwd,
} from '@agor/core/claude-cli';
import { SessionRepository, TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  type Session,
  type SessionID,
  SessionStatus,
  type Task,
  type TaskID,
  TaskStatus,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import {
  ClaudeCliWatcherRegistry,
  type CliWatcherEventSink,
  type CliWatcherStatePersister,
} from './claude-cli-watcher.js';

/**
 * Build a persister that writes watcher offset / last-event markers back to
 * the session row's `cli_state` field.
 *
 * `SessionRepository.update` deep-merges the flat Session-shaped patch into
 * the existing row (the JSON blob is unwrapped internally), so we pass a
 * plain `{ cli_state: {…} }` partial rather than a `{ data: { … } }`
 * wrapper. The earlier `{ data: { …row, cli_state } }` shape silently
 * mis-wrote the entire denormalized row back into the data blob's body.
 */
export function buildCliPersister(app: Application): CliWatcherStatePersister {
  return {
    async saveOffset(sessionId, update) {
      const db = (app.get('database') ?? app.get('db')) as
        | ConstructorParameters<typeof SessionRepository>[0]
        | undefined;
      if (!db) return;
      const repo = new SessionRepository(db);
      const row = await repo.findById(sessionId).catch(() => null);
      if (!row) return;
      const existing = row.cli_state ?? {};
      await repo.update(sessionId, {
        cli_state: {
          ...existing,
          watcher_offset: update.watcher_offset,
          last_event_ts: update.last_event_ts ?? existing.last_event_ts,
          last_event_uuid: update.last_event_uuid ?? existing.last_event_uuid,
        },
      } as unknown as Partial<Session>);
    },
  };
}

/**
 * Build the event sink — translates the JSONL watcher's structured events
 * into `messages` rows so the Agor "conversation" tab is fed by the same
 * pipeline as the SDK adapter.
 *
 * Index allocation: we use a per-session in-memory counter primed from
 * `countMessages` on the first event, then bump it. This avoids a DB
 * round-trip per event. If the daemon restarts mid-session, the counter
 * re-primes from the live row count, which is correct.
 *
 * Idempotency: assistant turns are already dedup'd in the translator
 * (one event per unique `message.id`). User events use `uuid` as a
 * synthetic dedup key — same `user` line never produces two writes in
 * the same watcher lifetime. Cross-restart dedup relies on the persisted
 * `cli_state.watcher_offset` — we resume past previously-written bytes.
 */
/**
 * Cross-module hand-off from the `/sessions/:id/prompt` route to the watcher.
 *
 * When the user prompts via Agor's textarea (or MCP `agor_sessions_prompt`),
 * the route creates a `tasks` row + writes the user message with that task_id
 * — same flow as the SDK adapter. It then PTY-injects the prompt text into
 * claude's REPL and stashes the pending task_id here. The watcher consumes it
 * on the next `user_message` JSONL line, links subsequent assistant/tool
 * messages to that same task_id, and closes the task on `turn_end`.
 *
 * Terminal-direct prompts (user types in the embedded xterm bypassing Agor's
 * textarea) don't hit /prompt, so the map is empty when their `user_message`
 * arrives — the watcher mints a task itself in that branch.
 *
 * One entry per session by design: the REPL is single-flight (claude doesn't
 * accept a new prompt while a turn is mid-stream), so we never need to queue
 * multiple pending tasks here.
 */
const pendingCliTask = new Map<SessionID, { taskId: TaskID; userMessageIndex: number }>();

/** Set by `/sessions/:id/prompt` for CLI sessions right before PTY-injection. */
export function setPendingCliTask(
  sessionId: SessionID,
  taskId: TaskID,
  userMessageIndex: number
): void {
  pendingCliTask.set(sessionId, { taskId, userMessageIndex });
}

/**
 * Build the event sink — translates the JSONL watcher's structured events
 * into `tasks` + `messages` rows so the read-only Agor conversation tab
 * renders CLI-driven turns through the same path as SDK-driven turns.
 *
 * Task lifecycle:
 *   - On `user_message`: claim the pending task (textarea path) OR mint a new
 *     task with status=RUNNING (terminal-direct path). Stamp every subsequent
 *     message for this session with that task_id.
 *   - On `assistant_message` / `tool_result`: tag with the active task_id.
 *   - On `turn_end` (assistant `stop_reason === 'end_turn'`): patch the task
 *     to COMPLETED + final `message_range`, patch the session back to IDLE.
 *
 * Index allocation: per-session in-memory counter primed from `countMessages`
 * on first use. Cross-restart correctness comes from the persisted
 * `cli_state.watcher_offset` — we resume past previously-written bytes.
 */
export function buildCliEventSink(app: Application): CliWatcherEventSink {
  // Per-session next-index cache. Primed from countMessages on first use.
  const indexBySession = new Map<string, number>();

  // Per-session active turn — set on `user_message`, cleared on `turn_end`.
  // The watcher uses this to stamp subsequent assistant/tool messages with
  // the right task_id without re-reading the DB.
  const activeCliTurn = new Map<
    string,
    { taskId: TaskID; userMessageIndex: number; lastIndex: number; lastTimestamp: string }
  >();

  const nextIndex = async (sessionId: SessionID): Promise<number> => {
    const cached = indexBySession.get(sessionId);
    if (cached !== undefined) {
      indexBySession.set(sessionId, cached + 1);
      return cached;
    }
    try {
      const db = (app.get('database') ?? app.get('db')) as
        | ConstructorParameters<typeof SessionRepository>[0]
        | undefined;
      if (!db) {
        indexBySession.set(sessionId, 1);
        return 0;
      }
      const repo = new SessionRepository(db);
      const count = (await repo.countMessages(sessionId).catch(() => 0)) ?? 0;
      indexBySession.set(sessionId, count + 1);
      return count;
    } catch {
      indexBySession.set(sessionId, 1);
      return 0;
    }
  };

  /** Trim a structured value down to a 200-char preview string. */
  const previewFor = (content: unknown): string => {
    if (typeof content === 'string') return content.slice(0, 200);
    if (!content) return '';
    try {
      return JSON.stringify(content).slice(0, 200);
    } catch {
      return String(content).slice(0, 200);
    }
  };

  /** Get the DB handle; null if not yet initialized (test harness etc). */
  const getDb = ():
    | ConstructorParameters<typeof SessionRepository>[0]
    | undefined =>
    (app.get('database') ?? app.get('db')) as
      | ConstructorParameters<typeof SessionRepository>[0]
      | undefined;

  /**
   * Terminal-direct path: there's no pending task from /prompt, so mint one
   * ourselves with status=RUNNING. Also patches the session row so the queue
   * gate behaves and `session.tasks` shows the new id in the worktree pill.
   */
  const mintTaskForOrphanTurn = async (
    sessionId: SessionID,
    prompt: string,
    userMessageIndex: number,
    timestamp: string
  ): Promise<TaskID | null> => {
    const db = getDb();
    if (!db) return null;
    try {
      const sessionRepo = new SessionRepository(db);
      const session = await sessionRepo.findById(sessionId).catch(() => null);
      if (!session) return null;
      const taskRepo = new TaskRepository(db);
      const task = (await taskRepo.create({
        session_id: sessionId,
        created_by: session.created_by,
        full_prompt: prompt,
        status: TaskStatus.RUNNING,
        started_at: timestamp,
        message_range: {
          start_index: userMessageIndex,
          end_index: userMessageIndex,
          start_timestamp: timestamp,
          end_timestamp: timestamp,
        },
        git_state: {
          ref_at_start: session.git_state?.ref ?? '',
          sha_at_start: session.git_state?.current_sha ?? '',
        },
        tool_use_count: 0,
        metadata: { source: 'cli-repl' },
      })) as Task;
      app.service('tasks').emit('created', task);
      // Patch session: RUNNING + append task id. The watcher's turn_end
      // handler flips it back to IDLE.
      await app
        .service('sessions')
        .patch(sessionId, {
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
          tasks: [...session.tasks, task.task_id],
        })
        .catch((err: unknown) => {
          console.warn(
            '[claude-cli-watcher.sink] session patch (RUNNING) failed',
            err
          );
        });
      return task.task_id as TaskID;
    } catch (err) {
      console.warn('[claude-cli-watcher.sink] mintTaskForOrphanTurn failed', err);
      return null;
    }
  };

  return async (sessionId, event) => {
    try {
      const messagesSvc = app.service('messages') as unknown as {
        create: (m: Record<string, unknown>) => Promise<unknown>;
      };
      const baseTs = new Date().toISOString();

      if (event.type === 'user_message') {
        if (event.isSidechain) return; // subagent rows skipped in v1
        const promptText =
          typeof event.content === 'string'
            ? event.content
            : (() => {
                try {
                  return JSON.stringify(event.content);
                } catch {
                  return String(event.content ?? '');
                }
              })();
        const ts = event.timestamp ?? baseTs;

        // Textarea / MCP path: /prompt already created the task AND wrote the
        // user message at userMessageIndex. We just need to prime the active
        // turn tracker so subsequent assistant/tool messages get linked.
        const pending = pendingCliTask.get(sessionId as SessionID);
        if (pending) {
          pendingCliTask.delete(sessionId as SessionID);
          // Re-seed the index cache so our next write follows /prompt's user row.
          indexBySession.set(sessionId, pending.userMessageIndex + 1);
          activeCliTurn.set(sessionId, {
            taskId: pending.taskId,
            userMessageIndex: pending.userMessageIndex,
            lastIndex: pending.userMessageIndex,
            lastTimestamp: ts,
          });
          return;
        }

        // Terminal-direct path: mint a fresh task + write the user message
        // ourselves. Index is allocated first so the task's message_range
        // points at the row we're about to write.
        const userIdx = await nextIndex(sessionId);
        const taskId = await mintTaskForOrphanTurn(
          sessionId as SessionID,
          promptText,
          userIdx,
          ts
        );
        if (!taskId) {
          // Couldn't mint task — write an orphan so we at least don't lose data.
          await messagesSvc.create({
            message_id: cryptoUuid(),
            session_id: sessionId,
            type: 'user',
            role: 'user',
            index: userIdx,
            timestamp: ts,
            content_preview: previewFor(event.content),
            content: typeof event.content === 'string' ? event.content : (event.content ?? ''),
            metadata: { source: 'cli-repl', original_id: event.uuid ?? undefined },
          });
          return;
        }
        await messagesSvc.create({
          message_id: cryptoUuid(),
          session_id: sessionId,
          task_id: taskId,
          type: 'user',
          role: 'user',
          index: userIdx,
          timestamp: ts,
          content_preview: previewFor(event.content),
          content: typeof event.content === 'string' ? event.content : (event.content ?? ''),
          metadata: { source: 'cli-repl', original_id: event.uuid ?? undefined },
        });
        activeCliTurn.set(sessionId, {
          taskId,
          userMessageIndex: userIdx,
          lastIndex: userIdx,
          lastTimestamp: ts,
        });
        return;
      }

      if (event.type === 'assistant_message') {
        if (event.turn.isSidechain) return; // subagent v1 skip
        const idx = await nextIndex(sessionId);
        const content = event.turn.content;
        const ts = event.turn.timestamp ?? baseTs;
        const active = activeCliTurn.get(sessionId);
        await messagesSvc.create({
          message_id: cryptoUuid(),
          session_id: sessionId,
          task_id: active?.taskId,
          type: 'assistant',
          role: 'assistant',
          index: idx,
          timestamp: ts,
          content_preview: previewFor(content),
          content,
          metadata: {
            model: event.turn.model ?? undefined,
            original_id: event.turn.messageId,
            stop_reason: event.turn.stopReason ?? undefined,
            tokens: event.turn.usage
              ? {
                  input: event.turn.usage.input_tokens ?? 0,
                  output: event.turn.usage.output_tokens ?? 0,
                  cache_creation: event.turn.usage.cache_creation_input_tokens ?? 0,
                  cache_read: event.turn.usage.cache_read_input_tokens ?? 0,
                }
              : undefined,
          },
        });
        if (active) {
          active.lastIndex = idx;
          active.lastTimestamp = ts;
        }
        return;
      }

      if (event.type === 'tool_result') {
        if (event.isSidechain) return;
        const idx = await nextIndex(sessionId);
        const ts = event.timestamp ?? baseTs;
        const active = activeCliTurn.get(sessionId);
        await messagesSvc.create({
          message_id: cryptoUuid(),
          session_id: sessionId,
          task_id: active?.taskId,
          type: 'user',
          role: 'user',
          index: idx,
          timestamp: ts,
          content_preview: previewFor(event.result),
          content: [
            {
              type: 'tool_result',
              tool_use_id: event.sourceToolAssistantUUID ?? undefined,
              content: event.result,
            },
          ],
          metadata: { original_id: event.uuid ?? undefined },
        });
        if (active) {
          active.lastIndex = idx;
          active.lastTimestamp = ts;
        }
        return;
      }

      if (event.type === 'turn_end') {
        const active = activeCliTurn.get(sessionId);
        if (!active) {
          console.log(
            JSON.stringify({
              layer: 'claude-cli-watcher.sink',
              sessionId,
              eventType: 'turn_end',
              note: 'no active turn — skipping close',
            })
          );
          return;
        }
        activeCliTurn.delete(sessionId);
        const ts = event.timestamp ?? active.lastTimestamp ?? baseTs;
        // Patch task to COMPLETED with the full message_range now that we
        // know the last index of the turn.
        try {
          await app.service('tasks').patch(active.taskId, {
            status: TaskStatus.COMPLETED,
            completed_at: ts,
            message_range: {
              start_index: active.userMessageIndex,
              end_index: active.lastIndex,
              end_timestamp: ts,
            },
          });
        } catch (err) {
          console.warn('[claude-cli-watcher.sink] task close failed', {
            sessionId,
            taskId: active.taskId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        // Flip the session back to IDLE so the prompt-queue gate stops
        // routing prompts into the queue.
        try {
          await app.service('sessions').patch(sessionId, {
            status: SessionStatus.IDLE,
            ready_for_prompt: true,
          });
        } catch (err) {
          console.warn('[claude-cli-watcher.sink] session IDLE patch failed', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      // Other events — `turn_start` / `ai_title` / `attachment` / `unknown`
      // / `last_prompt` — surface as a single-line log for now.
      console.log(
        JSON.stringify({
          layer: 'claude-cli-watcher.sink',
          sessionId,
          eventType: event.type,
        })
      );
    } catch (err) {
      console.warn('[claude-cli-watcher.sink] write failed', {
        sessionId,
        eventType: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/** Cheap UUIDv4 — avoids importing the full uuid lib in this hot path. */
function cryptoUuid(): string {
  // Use Node's `crypto.randomUUID()` (available since Node 19).
  return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
}

/**
 * Resolve the `$HOME` of the Unix user who owns the `~/.claude/` tree for a
 * given session.
 *
 * - `unix_user_mode: simple` / `insulated` → daemon user's home (one shared
 *   credentials.json across all CLI sessions).
 * - `unix_user_mode: strict` → session owner's home (per-user credentials).
 *
 * v1: just return the daemon's home. Strict-mode wiring lives with the
 * Unix-impersonation utilities and lands when RBAC mode is exercised.
 */
export function resolveHomeDirForCliSession(_session: Session): string {
  return os.homedir();
}

let registrySingleton: ClaudeCliWatcherRegistry | null = null;

/**
 * Singleton accessor for the watcher registry. The daemon constructs this
 * once at startup; tests should construct their own ClaudeCliWatcherRegistry
 * to keep state hermetic.
 */
export function getCliWatcherRegistry(app: Application): ClaudeCliWatcherRegistry {
  if (!registrySingleton) {
    registrySingleton = new ClaudeCliWatcherRegistry(
      buildCliPersister(app),
      buildCliEventSink(app),
      console
    );
  }
  return registrySingleton;
}

/**
 * Map an Agor session's permission_config.mode to the CLI's permission
 * flag. The CLI accepts the same set as the SDK plus `auto` and the
 * synthetic `dangerously-skip-permissions` (which emits the dedicated
 * argv flag instead of `--permission-mode bypassPermissions`).
 *
 * Returns `undefined` to mean "don't emit a permission flag at all" — the
 * CLI will fall back to its own default (`default`). For backgrounded
 * MCP-driven spawns the caller should pass `bypassPermissions` explicitly.
 */
function permissionModeForCli(session: Session): ClaudeCliPermissionMode | undefined {
  const mode = session.permission_config?.mode;
  if (!mode) return 'acceptEdits'; // v1 default for user-driven sessions
  // The SDK union `PermissionMode` overlaps with the CLI's accepted values
  // for the modes we care about. Anything we don't recognize gets dropped
  // (silently) by `buildClaudeCliSpawn`.
  return mode as unknown as ClaudeCliPermissionMode;
}

/**
 * Build the `ClaudeCliSpawnConfig` for a session.
 *
 * Encoded defaults:
 *   - `displayName` = `cli-<short>` (the Agor short id) so it shows up in
 *     `claude --resume` pickers + the terminal title.
 *   - `permissionMode` defaults to `acceptEdits` per the analysis doc's
 *     Defaults-panel out-of-box choice.
 *   - `addDirs` = `[worktree cwd]` so the agent has the worktree in its
 *     context even though that's also the spawn cwd. Cheap belt-and-suspenders.
 */
export function buildSpawnConfigForSession(
  session: Session,
  worktreeCwd: string
): ClaudeCliSpawnConfig {
  // If the JSONL transcript for this session id already exists on disk,
  // `claude --session-id <X>` errors out with "Session ID is already in
  // use." — claude's --session-id is strictly "create-new." On Restart /
  // reload-after-crash we want continuity, not a hard error, so switch
  // to `--resume <X>` whenever the transcript file is present. claude
  // treats --resume as idempotent across launches and preserves history.
  const homeDir = resolveHomeDirForCliSession(session);
  const jsonlPath = claudeSessionJsonlPath(homeDir, worktreeCwd, session.session_id);
  const transcriptExists = fs.existsSync(jsonlPath);
  return {
    sessionId: transcriptExists ? undefined : session.session_id,
    resumeSessionId: transcriptExists ? session.session_id : undefined,
    displayName: `cli-${session.session_id.slice(0, 8)}`,
    model: session.model_config?.model,
    effort: session.model_config?.effort as ClaudeCliSpawnConfig['effort'] | undefined,
    permissionMode: permissionModeForCli(session),
    addDirs: [worktreeCwd],
    // mcpConfigPath: lands once MCP scoping is plumbed for the CLI adapter.
    // appendSystemPromptFile: lands once session-context rendering is wired.
  };
}

/**
 * Best-effort PTY-tab dispatch into the user's running terminal executor.
 *
 * Sends a `terminal:tab` event on the user's terminal channel. If the user
 * has an open terminal modal (and therefore a running Zellij executor),
 * a new tab named `cli-<short>` opens with the `claude` binary already
 * spawned inside. If they don't, the event is dropped — they can open the
 * terminal later and create the tab manually, or we can wire a "ensure
 * executor + tab" path in a follow-up.
 *
 * Returns `true` if we attempted to dispatch (regardless of whether an
 * executor was listening), `false` if we couldn't even attempt
 * (missing io / userId / etc.).
 */
function dispatchZellijClaudeTab(
  app: Application,
  userId: string | null | undefined,
  tabName: string,
  cwd: string,
  command: string,
  commandArgs: string[]
): boolean {
  if (!userId) return false;
  const io = (app as unknown as { io?: { to(room: string): { emit(ev: string, p: unknown): void } } })
    .io;
  if (!io) return false;
  io.to(`user/${userId}/terminal`).emit('terminal:tab', {
    userId,
    action: 'create',
    tabName,
    cwd,
    command,
    commandArgs,
  });
  return true;
}

/**
 * Hook for the sessions service to invoke after creating a new session.
 *
 * For `claude-code-cli` sessions:
 *   1. Persist `data.cli_state` with the resolved slug, JSONL path, and
 *      the spawn argv. (Diagnostic — also lets a future "reattach"
 *      action recompute what to spawn.)
 *   2. Register a JSONL watcher so we start tailing as soon as the CLI
 *      writes its first line.
 *   3. Best-effort dispatch a `terminal:tab` to the user's running
 *      Zellij executor so the `claude` REPL launches in a new tab.
 *
 * No-op for non-CLI tools.
 */
export async function onCliSessionCreated(
  app: Application,
  session: Session,
  worktreeCwd: string
): Promise<void> {
  if (session.agentic_tool !== 'claude-code-cli') return;
  const homeDir = resolveHomeDirForCliSession(session);
  const slug = slugForCwd(worktreeCwd);
  const jsonlPath = claudeSessionJsonlPath(homeDir, worktreeCwd, session.session_id);
  const spawnCfg = buildSpawnConfigForSession(session, worktreeCwd);
  const built = buildClaudeCliSpawn(spawnCfg);
  const tabName = spawnCfg.displayName ?? `cli-${session.session_id.slice(0, 8)}`;

  // 1) Persist cli_state for diagnostics + restart recovery.
  const persister = buildCliPersister(app);
  await persister.saveOffset(session.session_id as unknown as SessionID, {
    watcher_offset: 0,
    last_event_ts: null,
    last_event_uuid: null,
  });
  // Patch cli_state + mirror `sdk_session_id` to the agor session id (for
  // the CLI adapter the two are the same value — we pass
  // `--session-id <agor.session_id>` — and the existing session-detail UI
  // surfaces `sdk_session_id` consistently across all agentic tools).
  //
  // `SessionRepository.update` deep-merges the flat patch into the row;
  // do NOT wrap in `{ data: { ... } }` — that mis-writes the whole
  // denormalized row into the JSON blob.
  try {
    const db = (app.get('database') ?? app.get('db')) as
      | ConstructorParameters<typeof SessionRepository>[0]
      | undefined;
    if (db) {
      const repo = new SessionRepository(db);
      const row = await repo.findById(session.session_id).catch(() => null);
      if (row) {
        await repo.update(session.session_id, {
          sdk_session_id: session.session_id,
          cli_state: {
            ...(row.cli_state ?? {}),
            slug,
            jsonl_path: jsonlPath,
            zellij_tab_name: tabName,
          },
        } as unknown as Partial<Session>);
      }
    }
  } catch (err) {
    console.warn('[claude-cli-integration] failed to persist initial cli_state', err);
  }

  // 2) Register the JSONL watcher (sits idle until `claude` writes its first line).
  try {
    const reg = getCliWatcherRegistry(app);
    await reg.register({
      sessionId: session.session_id as unknown as SessionID,
      cwd: worktreeCwd,
      homeDir,
      startOffset: session.cli_state?.watcher_offset ?? 0,
    });
  } catch (err) {
    console.warn(
      `[claude-cli-integration] watcher register failed for session ${session.session_id}:`,
      err
    );
  }

  // 3) Dispatch the `terminal:tab` so the claude REPL spawns in a Zellij tab.
  //    Best-effort — drops silently if the user hasn't opened the terminal
  //    modal yet. Log the attempt either way so we can see it in the
  //    daemon logs while testing.
  const dispatched = dispatchZellijClaudeTab(
    app,
    session.created_by,
    tabName,
    worktreeCwd,
    built.bin,
    built.args
  );
  console.log(
    JSON.stringify({
      layer: 'claude-cli-integration.onCliSessionCreated',
      sessionId: session.session_id,
      slug,
      jsonl_path: jsonlPath,
      tab_dispatched: dispatched,
      spawn: { bin: built.bin, args: built.args },
    })
  );
}

/**
 * Hook for the sessions service to invoke when a CLI session ends (status
 * → completed/failed/archived OR the PTY exits).
 */
export async function onCliSessionEnded(
  app: Application,
  sessionId: SessionID
): Promise<void> {
  const reg = getCliWatcherRegistry(app);
  await reg.unregister(sessionId);
}

/**
 * Re-instantiate watchers for every in-flight `claude-code-cli` session on
 * daemon startup. Picks up wherever the previous daemon process left off
 * via the persisted `watcher_offset` byte counter.
 */
export async function rehydrateCliWatchers(
  app: Application,
  worktreeCwdLookup: (worktreeId: string) => Promise<string | null>
): Promise<void> {
  const db = (app.get('database') ?? app.get('db')) as
    | ConstructorParameters<typeof SessionRepository>[0]
    | undefined;
  if (!db) return;
  const repo = new SessionRepository(db);

  // Scan for active CLI sessions. We don't have a direct "give me active
  // claude-code-cli sessions" query, so do the simple thing: list all
  // sessions, filter in memory. Numbers are small (hundreds at most).
  const all = (await repo.list({}).catch(() => [])) as unknown as Session[];
  const reg = getCliWatcherRegistry(app);
  let rehydrated = 0;
  for (const session of all) {
    if (session.agentic_tool !== 'claude-code-cli') continue;
    if (session.status === 'completed' || session.status === 'failed') continue;
    if (session.archived) continue;
    const cwd = await worktreeCwdLookup(session.worktree_id);
    if (!cwd) continue;
    try {
      await reg.register({
        sessionId: session.session_id as unknown as SessionID,
        cwd,
        homeDir: resolveHomeDirForCliSession(session),
        startOffset: session.cli_state?.watcher_offset ?? 0,
      });
      rehydrated++;
    } catch (err) {
      console.warn(
        `[claude-cli-integration] failed to rehydrate watcher for ${session.session_id}:`,
        err
      );
    }
  }
  if (rehydrated > 0) {
    console.log(`[claude-cli-integration] rehydrated ${rehydrated} CLI watcher(s)`);
  }
}

// Re-export for convenience.
export { ClaudeCliWatcherRegistry } from './claude-cli-watcher.js';
// Silence unused-import warning if DrizzleService is reserved for a follow-up.
void DrizzleService;
