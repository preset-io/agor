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

import { spawn as spawnProcess } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AssistantUsage,
  buildClaudeCliSpawn,
  type ClaudeCliModelUsageEntry,
  type ClaudeCliNormalizedSdkResponse,
  type ClaudeCliRawSdkResponse,
  type ClaudeCliSpawnConfig,
  claudeSessionJsonlPath,
  computeCost,
  getContextWindowLimit,
  permissionModeForCli,
  slugForCwd,
} from '@agor/core/claude-cli';
import {
  type Database,
  generateId,
  SessionRepository,
  shortId,
  TaskRepository,
} from '@agor/core/db';
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
import { buildInitialUserMessage } from '../utils/build-initial-user-message.js';
import { canReceiveMcpTokenForSession } from '../utils/mcp-token-authorization.js';
import { getDaemonUrl } from '../utils/spawn-executor.js';
import {
  ClaudeCliWatcherRegistry,
  type CliWatcherEventSink,
  type CliWatcherStatePersister,
} from './claude-cli-watcher.js';

/**
 * Typed accessor for the daemon's shared Drizzle handle. The Feathers
 * `Application` exposes `app.get(key)` as `any`, so the handful of call
 * sites in this file used to cast inline — now they share this helper
 * and the cast lives in exactly one place. Returns `null` rather than
 * throwing because the test harness wires apps without a DB.
 */
function getDb(app: Application): Database | null {
  const db = (app.get('database') ?? app.get('db')) as Database | undefined;
  return db ?? null;
}

/** Per-turn accumulator used by the sink between `user_message` and `turn_end`. */
interface AssistantTurnData {
  model: string | null;
  usage: AssistantUsage | null;
  messageId: string;
  timestamp: string | null;
  stopReason: string | null;
}

/** In-flight turn state — one entry per active CLI session. */
interface ActiveCliTurn {
  taskId: TaskID;
  userMessageIndex: number;
  lastIndex: number;
  lastTimestamp: string;
  startedAtMs: number;
  assistantTurns: AssistantTurnData[];
  lastAssistantRaw: unknown;
  toolUseCount: number;
}

/**
 * Per-session in-flight turn state. Lifted to module scope (was closure-
 * local) so:
 *   - the watcher's rehydration path (`primeActiveCliTurnFromSession`) can
 *     prime it after a daemon restart, BEFORE the sink processes any
 *     post-restart event;
 *   - the persister can write its DB-recoverable subset (task id, user
 *     message index, start time) to `cli_state.active_turn` and clear it
 *     on `turn_end`.
 *
 * Analytics accumulated mid-turn (`assistantTurns`, `lastAssistantRaw`,
 * `toolUseCount`) are *not* persisted — they re-accumulate from the
 * post-restart half of the JSONL. A turn straddling a restart will under-
 * report cost/tokens for the pre-restart half. The task linkage is what
 * matters for not orphaning messages.
 */
const activeCliTurn = new Map<string, ActiveCliTurn>();

/**
 * Write the recoverable subset of an active turn to `cli_state.active_turn`
 * so a daemon restart can rehydrate the task linkage. Called on
 * `user_message`. **Throws on failure** — the caller awaits this before
 * returning from the sink so the watcher's offset-on-success contract
 * stays honest: byte offset only advances after `active_turn` is durable.
 *
 * "No DB available" (test harness without `app.set('database', db)`) is
 * the only soft path — returns silently. Everything else throws.
 */
async function persistActiveTurnSnapshot(
  app: Application,
  sessionId: SessionID,
  turn: ActiveCliTurn
): Promise<void> {
  const db = getDb(app);
  if (!db) return;
  const repo = new SessionRepository(db);
  const row = await repo.findById(sessionId);
  if (!row) {
    throw new Error(`persistActiveTurnSnapshot: session not found: ${shortId(sessionId)}`);
  }
  const patch = {
    cli_state: {
      ...(row.cli_state ?? {}),
      active_turn: {
        task_id: turn.taskId,
        user_message_index: turn.userMessageIndex,
        started_at_ms: turn.startedAtMs,
      },
    },
  } satisfies Partial<Session>;
  await repo.update(sessionId, patch);
}

/**
 * Clear `cli_state.active_turn` on `turn_end`. Best-effort.
 *
 * We pass `null` rather than omitting the field because
 * `SessionRepository.update`'s deepMerge skips undefined values
 * (preserves the existing entry). Explicit `null` is the codebase's
 * documented "clear this field" signal — see
 * `packages/core/src/db/repositories/merge-utils.ts`.
 */
async function clearActiveTurnSnapshot(app: Application, sessionId: SessionID): Promise<void> {
  const db = getDb(app);
  if (!db) return;
  try {
    const repo = new SessionRepository(db);
    const patch = {
      cli_state: { active_turn: null },
    } satisfies Partial<Session>;
    await repo.update(sessionId, patch);
  } catch (err) {
    console.warn('[claude-cli-integration] clearActiveTurnSnapshot failed', err);
  }
}

/**
 * Rehydrate the in-memory `activeCliTurn` entry for a session from
 * its persisted `cli_state.active_turn`. Called by `onCliSessionCreated`
 * and `rehydrateCliWatchers` *before* the watcher starts dispatching
 * post-restart events, so the very first post-restart assistant message
 * inherits the right task_id.
 *
 * Per-turn analytics that weren't persisted (`assistantTurns`,
 * `lastAssistantRaw`, `toolUseCount`) start fresh — see the doc on
 * `activeCliTurn`.
 */
export function primeActiveCliTurnFromSession(app: Application, session: Session): void {
  const persisted = session.cli_state?.active_turn;
  if (!persisted) return;
  // Don't clobber an in-memory entry — if a turn happens to be active
  // right now in this process, that one is the source of truth.
  if (activeCliTurn.has(session.session_id)) return;
  activeCliTurn.set(session.session_id, {
    taskId: persisted.task_id as TaskID,
    userMessageIndex: persisted.user_message_index,
    lastIndex: persisted.user_message_index,
    lastTimestamp: new Date(persisted.started_at_ms).toISOString(),
    startedAtMs: persisted.started_at_ms,
    assistantTurns: [],
    lastAssistantRaw: null,
    toolUseCount: 0,
  });
  // Restart the stale-turn watchdog. If the pre-restart turn closed
  // cleanly the persisted snapshot would already have been cleared,
  // so reaching this branch means either claude is still mid-turn
  // (legitimate, the watchdog's idle-time guard handles it) or claude
  // died before the daemon could observe it (the watchdog closes the
  // task on the next tick).
  startTaskWatchdog(app, session.session_id as SessionID);
}

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
/**
 * Stale-task watchdog.
 *
 * The watcher closes tasks on `turn_end` JSONL events (any non-`tool_use`
 * `stop_reason`). It does NOT see "the user typed Ctrl-D in the REPL" or
 * "claude was killed externally" — those terminate the process without
 * writing a final assistant line. Without this watchdog, a session whose
 * REPL got killed sits in `RUNNING` forever, and the branch pill shows
 * "running" until the user notices and hits Restart.
 *
 * Design: one `setInterval` per active turn. Tick every WATCHDOG_TICK_MS;
 * if the active turn has been idle (no new JSONL events) for
 * WATCHDOG_IDLE_THRESHOLD_MS *and* `pgrep -f 'claude --session-id <X>'`
 * returns no match, the watchdog closes the turn via `closeActiveTurn`
 * with a synthetic timestamp = "now". Started on `user_message`, cleared
 * on `turn_end` and on session unregister.
 *
 * Idle guard is critical — a turn that's legitimately mid-stream (claude
 * thinking, multi-tool back-and-forth) MUST NOT be closed prematurely.
 * 90s is comfortably longer than any normal silence inside a turn and
 * still tight enough that users don't see "running" forever.
 */
const WATCHDOG_TICK_MS = 60_000;
const WATCHDOG_IDLE_THRESHOLD_MS = 90_000;
const watchdogTimers = new Map<string, NodeJS.Timeout>();

/**
 * Check whether a `claude` process is running for this Agor session id.
 *
 * **Both spawn forms must match.** `buildSpawnConfigForSession` emits
 * `--session-id <X>` on first launch but switches to `--resume <X>`
 * once the JSONL exists (idempotent restart). The watchdog was missing
 * resumed processes and false-positive-ing them as dead — closing
 * healthy in-flight tasks after the 90s idle threshold.
 *
 * Uses `pgrep -f` so the match works across impersonated Unix users
 * (the argv is visible to the daemon user via `/proc`). The regex
 * tolerates either flag and any argv ordering. Resolves `true` on
 * transient pgrep errors so a misbehaving binary doesn't trigger
 * spurious task-close events.
 */
export function isClaudeRunningFor(sessionId: SessionID): Promise<boolean> {
  return new Promise((resolve) => {
    // pgrep uses extended regex with -f. `(--session-id|--resume) <id>`
    // covers both spawn forms `buildClaudeCliSpawn` emits.
    const pattern = `claude .*(--session-id|--resume) ${sessionId}`;
    const proc = spawnProcess('pgrep', ['-f', pattern], { stdio: 'ignore' });
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(true));
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
      resolve(true);
    }, 3_000);
  });
}

function stopTaskWatchdog(sessionId: string): void {
  const t = watchdogTimers.get(sessionId);
  if (t) {
    clearInterval(t);
    watchdogTimers.delete(sessionId);
  }
}

/**
 * Forward-declared close-active-turn dispatcher. Populated by
 * `buildCliEventSink` so the watchdog and the `turn_end` branch share
 * one close path. Done as a module-level variable rather than an export
 * because the close logic depends on the sink's per-instance closures
 * (index cache, etc.) — at construction time the sink installs itself
 * here for the watchdog to call.
 */
let closeActiveTurnDispatch:
  | ((sessionId: SessionID, reason: 'turn_end' | 'claude_exited', ts: string) => Promise<void>)
  | null = null;

function startTaskWatchdog(app: Application, sessionId: SessionID): void {
  stopTaskWatchdog(sessionId);
  const timer = setInterval(async () => {
    const active = activeCliTurn.get(sessionId);
    if (!active) {
      // Turn already closed by some other path — stop watching.
      stopTaskWatchdog(sessionId);
      return;
    }
    const idleMs = Date.now() - (Date.parse(active.lastTimestamp) || active.startedAtMs);
    if (idleMs < WATCHDOG_IDLE_THRESHOLD_MS) return;
    const alive = await isClaudeRunningFor(sessionId);
    if (alive) return;
    console.log(
      JSON.stringify({
        layer: 'claude-cli-watcher.watchdog',
        sessionId,
        idleMs,
        note: 'claude process not running — closing stale turn',
      })
    );
    try {
      await closeActiveTurnDispatch?.(sessionId, 'claude_exited', new Date().toISOString());
    } catch (err) {
      console.warn('[claude-cli-watcher.watchdog] close dispatch failed', err);
    }
    stopTaskWatchdog(sessionId);
  }, WATCHDOG_TICK_MS);
  // Don't keep the event loop alive just for the watchdog.
  timer.unref?.();
  watchdogTimers.set(sessionId, timer);
}

export function buildCliPersister(app: Application): CliWatcherStatePersister {
  return {
    async saveOffset(sessionId, update) {
      const db = getDb(app);
      if (!db) return;
      const repo = new SessionRepository(db);
      const row = await repo.findById(sessionId).catch(() => null);
      if (!row) return;
      const existing = row.cli_state ?? {};
      const patch = {
        cli_state: {
          ...existing,
          watcher_offset: update.watcher_offset,
          last_event_ts: update.last_event_ts ?? existing.last_event_ts,
          last_event_uuid: update.last_event_uuid ?? existing.last_event_uuid,
        },
      } satisfies Partial<Session>;
      await repo.update(sessionId, patch);
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
  //
  // The `assistantTurns` map accumulates dedup'd assistant turn payloads
  // (one entry per unique `message.id` — the translator already drops
  // cumulative-snapshot repeats) so we can roll up tokens + cost into an
  // SDKResultMessage-shaped `raw_sdk_response` when `turn_end` fires.
  // `toolUseCount` increments for every `tool_use` content block seen so
  // the task's analytics card surfaces tool activity.
  //
  // Shape is exported at the module top as `ActiveCliTurn`. The Map
  // itself is module-level (see top of file) so the rehydration path
  // (`primeActiveCliTurnFromSession`) can populate it before the sink
  // fires post-restart.

  const nextIndex = async (sessionId: SessionID): Promise<number> => {
    const cached = indexBySession.get(sessionId);
    if (cached !== undefined) {
      indexBySession.set(sessionId, cached + 1);
      return cached;
    }
    try {
      const db = getDb(app);
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

  /**
   * Terminal-direct path: there's no pending task from /prompt, so mint one
   * ourselves with status=RUNNING. Also patches the session row so the queue
   * gate behaves and `session.tasks` shows the new id in the branch pill.
   */
  const mintTaskForOrphanTurn = async (
    sessionId: SessionID,
    prompt: string,
    userMessageIndex: number,
    timestamp: string
  ): Promise<TaskID | null> => {
    const db = getDb(app);
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
          console.warn('[claude-cli-watcher.sink] session patch (RUNNING) failed', err);
        });
      return task.task_id as TaskID;
    } catch (err) {
      console.warn('[claude-cli-watcher.sink] mintTaskForOrphanTurn failed', err);
      return null;
    }
  };

  const sink: CliWatcherEventSink = async (sessionId, event) => {
    try {
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
          const turn: ActiveCliTurn = {
            taskId: pending.taskId,
            userMessageIndex: pending.userMessageIndex,
            lastIndex: pending.userMessageIndex,
            lastTimestamp: ts,
            startedAtMs: Date.parse(ts) || Date.now(),
            assistantTurns: [],
            lastAssistantRaw: null,
            toolUseCount: 0,
          };
          activeCliTurn.set(sessionId, turn);
          // Persist the recoverable subset BEFORE returning so the
          // watcher's offset-on-success guarantee holds: if we commit
          // the byte offset past the user_message line, the DB has the
          // active_turn snapshot needed to rehydrate post-restart.
          // Fire-and-forget here would race: a daemon crash between the
          // offset persist and the active_turn persist orphans every
          // subsequent assistant turn for this session.
          await persistActiveTurnSnapshot(app, sessionId as SessionID, turn);
          // Start the stale-turn watchdog. Closes the task if claude
          // dies without writing `end_turn` (Ctrl-D, kill -9, crash).
          startTaskWatchdog(app, sessionId as SessionID);
          return;
        }

        // Terminal-direct path: mint a fresh task + write the user message
        // ourselves. Index is allocated first so the task's message_range
        // points at the row we're about to write.
        const userIdx = await nextIndex(sessionId);
        const taskId = await mintTaskForOrphanTurn(sessionId as SessionID, promptText, userIdx, ts);
        // Both branches (orphan-fallback when task minting failed, and the
        // normal "linked to a freshly-minted task" case) share the same
        // row shape via `buildInitialUserMessage` — same helper the
        // /prompt route uses for the daemon-writes path. `task_id` falls
        // through to `undefined` when we couldn't mint.
        const userMessage = buildInitialUserMessage({
          sessionId: sessionId as SessionID,
          taskId: taskId ?? undefined,
          index: userIdx,
          timestamp: ts,
          content:
            typeof event.content === 'string' ? event.content : ((event.content ?? '') as string),
          metadata: { source: 'cli-repl', original_id: event.uuid ?? undefined },
        });
        await app.service('messages').create(userMessage);
        if (!taskId) return;
        const turn: ActiveCliTurn = {
          taskId,
          userMessageIndex: userIdx,
          lastIndex: userIdx,
          lastTimestamp: ts,
          startedAtMs: Date.parse(ts) || Date.now(),
          assistantTurns: [],
          lastAssistantRaw: null,
          toolUseCount: 0,
        };
        activeCliTurn.set(sessionId, turn);
        // Await — see comment on the textarea path above. Same
        // offset-on-success durability contract.
        await persistActiveTurnSnapshot(app, sessionId as SessionID, turn);
        startTaskWatchdog(app, sessionId as SessionID);
        return;
      }

      if (event.type === 'assistant_message') {
        if (event.turn.isSidechain) return; // subagent v1 skip
        const idx = await nextIndex(sessionId);
        const content = event.turn.content;
        const ts = event.turn.timestamp ?? baseTs;
        const active = activeCliTurn.get(sessionId);
        await app.service('messages').create({
          message_id: generateId(),
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
          // Accumulate the assistant turn for the analytics rollup at
          // turn_end. The translator already drops cumulative-snapshot
          // duplicates by message.id, so every entry here is a real new
          // chunk of usage/output. `event.turn.usage` is already
          // `AssistantUsage` from the translator — keep it as-is.
          active.assistantTurns.push({
            model: event.turn.model ?? null,
            usage: event.turn.usage ?? null,
            messageId: event.turn.messageId,
            timestamp: event.turn.timestamp ?? null,
            stopReason: event.turn.stopReason ?? null,
          });
          // Snapshot the latest assistant payload for raw_sdk_response.
          active.lastAssistantRaw = {
            message: {
              id: event.turn.messageId,
              type: 'message',
              role: 'assistant',
              model: event.turn.model,
              content,
              stop_reason: event.turn.stopReason,
              usage: event.turn.usage,
            },
            timestamp: event.turn.timestamp,
          };
          // Count tool_use blocks for the task's tool_use_count field.
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === 'object' &&
                (block as { type?: string }).type === 'tool_use'
              ) {
                active.toolUseCount += 1;
              }
            }
          }
        }
        return;
      }

      if (event.type === 'tool_result') {
        if (event.isSidechain) return;
        const idx = await nextIndex(sessionId);
        const ts = event.timestamp ?? baseTs;
        const active = activeCliTurn.get(sessionId);
        await app.service('messages').create({
          message_id: generateId(),
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
        // Clear the persisted snapshot so a daemon restart after this
        // point doesn't try to rehydrate a turn that has already closed.
        void clearActiveTurnSnapshot(app, sessionId as SessionID);
        stopTaskWatchdog(sessionId);
        const ts = event.timestamp ?? active.lastTimestamp ?? baseTs;
        const endedAtMs = Date.parse(ts) || Date.now();
        const durationMs = Math.max(0, endedAtMs - active.startedAtMs);

        // Aggregate the dedup'd assistant turns into the SDK-shaped
        // `raw_sdk_response` (SDKResultMessage) so downstream normalizers,
        // cost cards, and analytics work the same way as for SDK sessions.
        //
        // The Claude Agent SDK exposes per-model usage as a `modelUsage`
        // object — we build the same map by summing each assistant turn's
        // usage under its model id.
        const modelUsageMap: Record<string, ClaudeCliModelUsageEntry> = {};
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheCreation = 0;
        let totalCacheRead = 0;
        let totalCostUsd: number | undefined;
        let primaryModel: string | undefined;
        for (const turn of active.assistantTurns) {
          const modelId = turn.model ?? 'unknown';
          if (!primaryModel && turn.model) primaryModel = turn.model;
          const u = turn.usage ?? {};
          const tIn = u.input_tokens ?? 0;
          const tOut = u.output_tokens ?? 0;
          const tCacheC = u.cache_creation_input_tokens ?? 0;
          const tCacheR = u.cache_read_input_tokens ?? 0;
          totalInput += tIn;
          totalOutput += tOut;
          totalCacheCreation += tCacheC;
          totalCacheRead += tCacheR;
          const entry = modelUsageMap[modelId] ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: getContextWindowLimit(turn.model),
          };
          entry.inputTokens += tIn;
          entry.outputTokens += tOut;
          entry.cacheCreationInputTokens += tCacheC;
          entry.cacheReadInputTokens += tCacheR;
          modelUsageMap[modelId] = entry;
          const turnCost = computeCost(turn.model, u);
          if (turnCost !== undefined) {
            totalCostUsd = (totalCostUsd ?? 0) + turnCost;
          }
        }

        // Build an SDKResultMessage-shaped raw payload. We deliberately
        // mirror the SDK's structure (modelUsage / usage / duration_ms /
        // total_cost_usd) rather than just dumping the last JSONL line
        // verbatim — the existing `ClaudeCodeNormalizer` reads this
        // shape, so downstream UIs see CLI turns the same as SDK turns.
        const rawSdkResponse: ClaudeCliRawSdkResponse = {
          type: 'result',
          subtype: 'success',
          session_id: sessionId,
          duration_ms: durationMs,
          total_cost_usd: totalCostUsd,
          modelUsage: modelUsageMap,
          usage: {
            input_tokens: totalInput,
            output_tokens: totalOutput,
            cache_read_input_tokens: totalCacheRead,
            cache_creation_input_tokens: totalCacheCreation,
          },
          // Provenance: keeping the last assistant payload around helps
          // debug "did we miss the end_turn?" cases without re-parsing
          // the JSONL.
          _cli_provenance: {
            adapter: 'claude-code-cli',
            assistantTurns: active.assistantTurns.length,
            lastAssistantSnapshot: active.lastAssistantRaw,
          },
        };

        // Precompute the normalized shape so the UI's cost / token cards
        // light up without depending on the executor-side normalizer
        // factory (which we don't import from the daemon).
        const normalizedSdkResponse: ClaudeCliNormalizedSdkResponse = {
          tokenUsage: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            totalTokens: totalInput + totalOutput,
            cacheReadTokens: totalCacheRead,
            cacheCreationTokens: totalCacheCreation,
          },
          contextWindowLimit:
            Math.max(0, ...Object.values(modelUsageMap).map((m) => m.contextWindow)) || 200_000,
          costUsd: totalCostUsd,
          primaryModel,
          durationMs,
        };

        // computed_context_window mirrors the SDK semantics: the
        // cumulative tokens the next turn would see if it started now.
        // For the CLI that's the last assistant turn's
        // (input + cache_creation + cache_read) — output isn't part of
        // the next turn's *input* so we exclude it. Output is still
        // available via the tokenUsage rollup.
        const lastTurn = active.assistantTurns[active.assistantTurns.length - 1];
        const computedContextWindow = lastTurn?.usage
          ? (lastTurn.usage.input_tokens ?? 0) +
            (lastTurn.usage.cache_creation_input_tokens ?? 0) +
            (lastTurn.usage.cache_read_input_tokens ?? 0)
          : undefined;

        // Patch task to COMPLETED with the full message_range + analytics.
        try {
          await app.service('tasks').patch(active.taskId, {
            status: TaskStatus.COMPLETED,
            completed_at: ts,
            message_range: {
              start_index: active.userMessageIndex,
              end_index: active.lastIndex,
              end_timestamp: ts,
            },
            model: primaryModel,
            duration_ms: durationMs,
            tool_use_count: active.toolUseCount,
            raw_sdk_response: rawSdkResponse,
            normalized_sdk_response: normalizedSdkResponse,
            computed_context_window: computedContextWindow,
          });
        } catch (err) {
          console.warn('[claude-cli-watcher.sink] task close failed', {
            sessionId,
            taskId: active.taskId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        // Mirror the latest context-usage snapshot up onto the session
        // row so the branch pill's "X% of context" pill shows the
        // right number across reload boundaries.
        try {
          const patch: Partial<Session> = {
            status: SessionStatus.IDLE,
            ready_for_prompt: true,
          };
          if (computedContextWindow !== undefined) {
            patch.current_context_usage = computedContextWindow;
            patch.context_window_limit = normalizedSdkResponse.contextWindowLimit;
            patch.last_context_update_at = ts;
          }
          await app.service('sessions').patch(sessionId, patch);
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
      // Re-throw so the watcher's `readAndDispatch` loop sees the
      // failure and **does not advance the byte offset**. Without
      // re-throwing, the offset-on-success guarantee in
      // claude-cli-watcher.ts is illusory — DB/service errors would
      // silently consume JSONL bytes that were never durably
      // recorded. The watcher logs the error at its own catch site
      // and pauses progress on this line; next `fs.watch` tick
      // re-reads + re-attempts.
      console.warn('[claude-cli-watcher.sink] write failed (re-throwing)', {
        sessionId,
        eventType: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  // Install the watchdog → sink bridge. The watchdog has no business
  // knowing the close-task-and-flip-session details — it just synthesizes
  // a `turn_end` event and lets the sink's existing branch handle it.
  // Same code path = same analytics + DB writes whether the close was
  // triggered by claude itself or by the watchdog noticing claude died.
  closeActiveTurnDispatch = async (
    sessionId: SessionID,
    _reason: 'turn_end' | 'claude_exited',
    ts: string
  ) => {
    await sink(sessionId, {
      type: 'turn_end',
      messageId: 'watchdog-synthetic',
      timestamp: ts,
    });
  };

  return sink;
}

/**
 * Resolve the `$HOME` of the Unix user who owns the `~/.claude/` tree for
 * a given session.
 *
 * - `unix_user_mode: simple` → daemon user's home (one shared
 *   credentials.json across all CLI sessions).
 * - `unix_user_mode: insulated` → daemon user's home (executor runs as
 *   a shared `executor_unix_user`, but the daemon still owns the
 *   `~/.claude/` tree — credentials are shared, transcripts live under
 *   the daemon HOME the executor `sudo -u`'s into).
 * - `unix_user_mode: strict` → session creator's home. Each user has
 *   their own `~/.claude/projects/<slug>/<session-id>.jsonl`, so the
 *   watcher must tail under THAT user's HOME, not the daemon's.
 *
 * `session.unix_username` is the impersonated user — stamped at session
 * create time by the `setSessionUnixUsername` hook. When non-null we
 * trust the canonical `/home/<username>` convention used everywhere
 * else in the daemon (see `terminals.ts`'s `symlinkPath`); querying
 * `/etc/passwd` from inside the daemon would require a sudo escalation
 * and isn't worth it for v1.
 */
export function resolveHomeDirForCliSession(session: Session): string {
  if (session.unix_username) {
    return `/home/${session.unix_username}`;
  }
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
 * Build the `ClaudeCliSpawnConfig` for a session.
 *
 * Encoded defaults:
 *   - `displayName` = `cli-<short>` (the Agor short id) so it shows up in
 *     `claude --resume` pickers + the terminal title.
 *   - `permissionMode` defaults to `acceptEdits` per the analysis doc's
 *     Defaults-panel out-of-box choice.
 *   - `addDirs` = `[branch cwd]` so the agent has the branch in its
 *     context even though that's also the spawn cwd. Cheap belt-and-suspenders.
 */
export function buildSpawnConfigForSession(
  session: Session,
  branchCwd: string,
  opts: { mcpConfigPath?: string } = {}
): ClaudeCliSpawnConfig {
  // If the JSONL transcript for this session id already exists on disk,
  // `claude --session-id <X>` errors out with "Session ID is already in
  // use." — claude's --session-id is strictly "create-new." On Restart /
  // reload-after-crash we want continuity, not a hard error, so switch
  // to `--resume <X>` whenever the transcript file is present. claude
  // treats --resume as idempotent across launches and preserves history.
  const homeDir = resolveHomeDirForCliSession(session);
  const jsonlPath = claudeSessionJsonlPath(homeDir, branchCwd, session.session_id);
  const transcriptExists = fs.existsSync(jsonlPath);
  return {
    sessionId: transcriptExists ? undefined : session.session_id,
    resumeSessionId: transcriptExists ? session.session_id : undefined,
    displayName: `cli-${shortId(session.session_id)}`,
    model: session.model_config?.model,
    effort: session.model_config?.effort as ClaudeCliSpawnConfig['effort'] | undefined,
    permissionMode: permissionModeForCli(session.permission_config?.mode),
    addDirs: [branchCwd],
    mcpConfigPath: opts.mcpConfigPath,
    // appendSystemPromptFile: lands once session-context rendering is wired.
  };
}

export interface ClaudeCliAgorMcpConfig {
  mcpServers: {
    agor: {
      type: 'http';
      url: string;
      headers: { Authorization: string };
    };
  };
}

/**
 * Build the Claude CLI `--mcp-config` payload for Agor's built-in MCP server.
 *
 * This mirrors the Agent SDK path in
 * `packages/executor/src/sdk-handlers/claude/query-builder.ts`, but writes the
 * shape the Claude Code CLI expects in an mcp config file. The Authorization
 * header carries a session-scoped MCP token, so Claude CLI sessions (including
 * `/schedule` setup flows that read this config at CLI start time) see the same
 * Agor board/session tools as normal Agor sessions instead of falling back to
 * unauthenticated REST.
 */
export function buildClaudeCliAgorMcpConfig(params: {
  daemonUrl: string;
  mcpToken: string;
}): ClaudeCliAgorMcpConfig {
  const daemonUrl = params.daemonUrl.replace(/\/+$/, '');
  return {
    mcpServers: {
      agor: {
        type: 'http',
        url: `${daemonUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${params.mcpToken}`,
        },
      },
    },
  };
}

/**
 * Write a per-session Claude CLI MCP config file and return its path.
 *
 * Best-effort by design: failing to write this file should not block opening a
 * CLI session, but it must be loud in logs because missing this file removes
 * all `agor_*` MCP tools (boards/cards/sessions/etc.) from Claude CLI and
 * RemoteTrigger scheduled runs.
 *
 * Token lifetime follows `execution.mcp_token_expiration_ms` via the shared MCP
 * session-token issuer. This writer does not mint a separate durable
 * RemoteTrigger credential; if a third-party scheduler snapshots headers for
 * longer than that TTL, it must refresh this config or use an explicit
 * future schedule-token design.
 */
export async function writeClaudeCliMcpConfigForSession(
  app: Application,
  session: Session,
  opts: {
    /**
     * External actor requesting this config. When omitted, the call is an
     * internal trusted spawn path (session create hook / service account).
     */
    actor?: { user_id?: string; role?: string } | null;
  } = {}
): Promise<string | undefined> {
  const config = app.get('config') as { daemon?: { mcpEnabled?: boolean } } | undefined;
  if (config?.daemon?.mcpEnabled === false) return undefined;

  if (
    opts.actor &&
    !canReceiveMcpTokenForSession({
      callerUserId: opts.actor.user_id,
      callerRole: opts.actor.role,
      sessionCreatedBy: session.created_by,
    })
  ) {
    console.warn(
      `[claude-cli-integration] not writing owner-scoped MCP config for session ${shortId(session.session_id)}: caller ${opts.actor.user_id ?? 'anonymous'} cannot receive session creator token`
    );
    return undefined;
  }

  try {
    const { generateSessionToken } = await import('../mcp/tokens.js');
    const mcpToken = await generateSessionToken(
      app,
      session.session_id,
      session.created_by as import('@agor/core/types').UserID
    );
    const mcpConfig = buildClaudeCliAgorMcpConfig({
      daemonUrl: getDaemonUrl(),
      mcpToken,
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agor-mcp-${shortId(session.session_id)}-`));
    const filePath = path.join(dir, 'mcp.json');
    fs.writeFileSync(filePath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 });

    // In strict Unix-user mode the CLI process may run as the session's Unix
    // user. If the daemon is privileged, hand ownership of the temp config to
    // that user so we can keep 0600 instead of making bearer tokens world-
    // readable in /tmp. Non-root deployments where chown is unavailable still
    // work in simple mode (same Unix user); otherwise the warning below tells
    // operators why MCP is missing.
    if (session.unix_username && typeof process.getuid === 'function' && process.getuid() === 0) {
      try {
        const homeStat = fs.statSync(`/home/${session.unix_username}`);
        fs.chownSync(dir, homeStat.uid, homeStat.gid);
        fs.chownSync(filePath, homeStat.uid, homeStat.gid);
      } catch (err) {
        console.warn(
          `[claude-cli-integration] failed to chown MCP config for ${session.unix_username}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    return filePath;
  } catch (err) {
    console.warn(
      `[claude-cli-integration] failed to write MCP config for session ${shortId(session.session_id)}; Agor MCP tools will be unavailable in Claude CLI/RemoteTrigger:`,
      err instanceof Error ? err.message : String(err)
    );
    return undefined;
  }
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
  if (!app.io) return false;
  app.io.to(`user/${userId}/terminal`).emit('terminal:tab', {
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
  branchCwd: string
): Promise<void> {
  if (session.agentic_tool !== 'claude-code-cli') return;
  const homeDir = resolveHomeDirForCliSession(session);
  const slug = slugForCwd(branchCwd);
  const jsonlPath = claudeSessionJsonlPath(homeDir, branchCwd, session.session_id);
  const mcpConfigPath = await writeClaudeCliMcpConfigForSession(app, session);
  const spawnCfg = buildSpawnConfigForSession(session, branchCwd, { mcpConfigPath });
  const built = buildClaudeCliSpawn(spawnCfg);
  const tabName = spawnCfg.displayName ?? `cli-${shortId(session.session_id)}`;

  // 1) Persist cli_state for diagnostics + restart recovery.
  const persister = buildCliPersister(app);
  await persister.saveOffset(session.session_id, {
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
    const db = getDb(app);
    if (db) {
      const repo = new SessionRepository(db);
      const row = await repo.findById(session.session_id).catch(() => null);
      if (row) {
        const patch = {
          sdk_session_id: session.session_id,
          cli_state: {
            ...(row.cli_state ?? {}),
            slug,
            jsonl_path: jsonlPath,
            zellij_tab_name: tabName,
          },
        } satisfies Partial<Session>;
        await repo.update(session.session_id, patch);
      }
    }
  } catch (err) {
    console.warn('[claude-cli-integration] failed to persist initial cli_state', err);
  }

  // 2) Register the JSONL watcher (sits idle until `claude` writes its first line).
  try {
    const reg = getCliWatcherRegistry(app);
    await reg.register({
      sessionId: session.session_id,
      cwd: branchCwd,
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
    branchCwd,
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
export async function onCliSessionEnded(app: Application, sessionId: SessionID): Promise<void> {
  const reg = getCliWatcherRegistry(app);
  await reg.unregister(sessionId);
  // Belt-and-suspenders: tear down the watchdog if it's still alive.
  // Normal turn_end already does this; covers the "session archived
  // mid-turn" path.
  stopTaskWatchdog(sessionId);
  activeCliTurn.delete(sessionId);
}

/**
 * Re-instantiate watchers for every in-flight `claude-code-cli` session on
 * daemon startup. Picks up wherever the previous daemon process left off
 * via the persisted `watcher_offset` byte counter.
 */
export async function rehydrateCliWatchers(
  app: Application,
  branchCwdLookup: (branchId: string) => Promise<string | null>
): Promise<void> {
  const db = getDb(app);
  if (!db) return;
  const repo = new SessionRepository(db);

  // Scan for active CLI sessions. We don't have a direct "give me active
  // claude-code-cli sessions" query, so do the simple thing: list all
  // sessions, filter in memory. Numbers are small (hundreds at most).
  const all = await repo.findAll().catch(() => [] as Session[]);
  const reg = getCliWatcherRegistry(app);
  let rehydrated = 0;
  for (const session of all) {
    if (session.agentic_tool !== 'claude-code-cli') continue;
    if (session.status === 'completed' || session.status === 'failed') continue;
    if (session.archived) continue;
    const cwd = await branchCwdLookup(session.branch_id);
    if (!cwd) continue;
    // Prime the in-memory active turn BEFORE registering the watcher so
    // the very first post-restart event sees the right task linkage.
    primeActiveCliTurnFromSession(app, session);
    try {
      await reg.register({
        sessionId: session.session_id,
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
