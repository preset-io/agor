/**
 * Claude CLI JSONL watcher service.
 *
 * Tails `~/.claude/projects/<slug>/<session-id>.jsonl` for each active
 * `agentic_tool === 'claude-code-cli'` session using kernel-driven
 * `fs.watch` (inotify on Linux) — no polling. Each new line gets parsed
 * via the @agor/core JsonlEventTranslator (cumulative-snapshot dedup
 * baked in) and dispatched to a caller-supplied sink.
 *
 * Design rationale + full architecture in
 * docs/internal/claude-code-cli-integration-analysis-2026-05-14.md §
 * "Watcher". Key invariants:
 *
 *   - Zero CPU when idle. The kernel notifies us; we never poll.
 *   - Resumable. Bytes consumed are persisted on the session row's
 *     `data.cli_state.watcher_offset` so a daemon restart rebuilds state
 *     from `cli_state.watcher_offset` onward.
 *   - Line-buffered. Every JSONL line is a complete JSON object; we hold
 *     over a trailing fragment between events if a write spans
 *     `change` notifications.
 *   - Defensive parser. Unknown event types log + skip rather than throw.
 *
 * What this file does NOT do (yet):
 *   - Watch subagent JSONL files (parent slug-dir watcher → child file
 *     watcher). Stubbed; will be added with subagent UI work.
 *   - Cost rollup. Once ccusage is installed, the translator's
 *     `assistant_message` events will be enriched via
 *     `ccusage/data-loader.calculateCostForEntry`. For now the translator
 *     emits raw usage numbers and downstream is responsible.
 *   - PTY injection. Lives in a sibling module (TBD); the watcher only
 *     reports turn boundaries via `turn_end` events so the queue drainer
 *     can act on them.
 */

import { type FSWatcher, promises as fsp, watch } from 'node:fs';
import path from 'node:path';
import {
  claudeSessionJsonlPath,
  claudeSubagentsDir,
  JsonlEventTranslator,
  type TranslatedEvent,
} from '@agor/core/claude-cli';
import type { SessionID } from '@agor/core/types';

/** Persistence sink — caller-supplied, typically writes to
 *  `sessions.data.cli_state` on the session row. */
export interface CliWatcherStatePersister {
  saveOffset(
    sessionId: SessionID,
    update: {
      watcher_offset: number;
      last_event_ts?: string | null;
      last_event_uuid?: string | null;
    }
  ): Promise<void>;
}

/** Event sink — caller-supplied, typically dispatches to MessagesService /
 *  TasksService writes + WebSocket fanout. */
export type CliWatcherEventSink = (
  sessionId: SessionID,
  event: TranslatedEvent
) => void | Promise<void>;

export interface CliWatcherOptions {
  /** Agor session id (also the `claude --session-id`). */
  sessionId: SessionID;
  /** Working dir the CLI was launched from. Drives the slug. */
  cwd: string;
  /** Resolved `$HOME` of the Unix user owning the `~/.claude/` tree.
   *  In `simple`/`insulated` Unix mode = daemon user; in `strict` = session
   *  creator. */
  homeDir: string;
  /** Where to resume from on first poke. 0 on fresh sessions. */
  startOffset?: number;
  /** Persister for offset writes. */
  persister: CliWatcherStatePersister;
  /** Sink for translated events. */
  sink: CliWatcherEventSink;
  /** Persist the offset every N lines processed (default: 25). */
  persistEveryNLines?: number;
  /** Persist the offset every T ms (default: 5_000). Whichever fires first. */
  persistEveryMs?: number;
  /** Console-style logger for warnings (parse errors, schema drift). */
  log?: Pick<Console, 'warn' | 'info' | 'error' | 'debug'>;
}

const DEFAULT_PERSIST_EVERY_N_LINES = 25;
const DEFAULT_PERSIST_EVERY_MS = 5_000;
/** Initial fast retry: poll the file every 100ms for up to ~5s so the
 *  common "claude spawning right now" case latches on quickly. */
const FILE_NOT_FOUND_FAST_BACKOFF_MS = 100;
const FILE_NOT_FOUND_FAST_RETRIES = 50;
/** After fast retries exhaust, fall back to a long-lived `fs.watch` on the
 *  parent slug directory so we wait patiently for the JSONL to appear —
 *  even if the user only opens the terminal modal hours later. */
const PARENT_DIR_CHECK_INTERVAL_MS = 30_000;

/**
 * Tails a single Claude CLI JSONL transcript.
 *
 * One instance per active session. Call `.start()` to begin watching;
 * `.stop()` to tear down (also flushes the offset).
 */
export class ClaudeCliWatcher {
  private readonly translator = new JsonlEventTranslator();
  private readonly opts: Required<Omit<CliWatcherOptions, 'startOffset' | 'log'>> & {
    startOffset: number;
    log: Pick<Console, 'warn' | 'info' | 'error' | 'debug'>;
  };
  private readonly jsonlPath: string;
  private readonly subagentsDir: string;
  private watcher: FSWatcher | null = null;
  /** Long-lived watch on the parent slug dir while waiting for the JSONL
   *  to appear. Closed once we successfully open the file. */
  private parentDirWatcher: FSWatcher | null = null;
  /** Backstop polling timer for the slow-path "waiting on JSONL" state. */
  private parentDirPollTimer: NodeJS.Timeout | null = null;
  private offset: number;
  /** Trailing fragment held over between `change` events when the last
   *  write didn't end in `\n`. */
  private lineBuffer = '';
  /** Lines processed since the last `persistOffset()` flush. */
  private linesSinceFlush = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Last seen `assistant.timestamp` / `uuid` for telemetry / resume-sanity. */
  private lastEventTs: string | null = null;
  private lastEventUuid: string | null = null;
  /** Serialize the read-and-dispatch loop so overlapping `change`
   *  notifications don't interleave. */
  private busy = Promise.resolve();
  private stopped = false;

  constructor(options: CliWatcherOptions) {
    this.opts = {
      sessionId: options.sessionId,
      cwd: options.cwd,
      homeDir: options.homeDir,
      startOffset: options.startOffset ?? 0,
      persister: options.persister,
      sink: options.sink,
      persistEveryNLines: options.persistEveryNLines ?? DEFAULT_PERSIST_EVERY_N_LINES,
      persistEveryMs: options.persistEveryMs ?? DEFAULT_PERSIST_EVERY_MS,
      log: options.log ?? console,
    };
    this.offset = this.opts.startOffset;
    this.jsonlPath = claudeSessionJsonlPath(this.opts.homeDir, this.opts.cwd, this.opts.sessionId);
    this.subagentsDir = claudeSubagentsDir(this.opts.homeDir, this.opts.cwd, this.opts.sessionId);
  }

  /** Absolute path to the JSONL we're watching. */
  get path(): string {
    return this.jsonlPath;
  }

  /** Where the subagent JSONLs would live (we don't watch this yet). */
  get subagentsPath(): string {
    return this.subagentsDir;
  }

  /** Current byte offset into the JSONL. */
  get currentOffset(): number {
    return this.offset;
  }

  /**
   * Begin watching. Resolves once the file is either found (and an initial
   * pass over `[startOffset, EOF)` has run) OR we've fallen through to the
   * patient `watching-parent-dir` slow path.
   *
   * Two-tier wait:
   *   1. **Fast path** — poll the JSONL every 100ms for up to ~5s. This
   *      latches on quickly in the common case where `claude` is spawning
   *      right alongside us (sub-100ms is typical per the analysis doc).
   *   2. **Slow path** — once the fast retries exhaust, `start()` returns
   *      and we install an `fs.watch` on the parent slug directory plus
   *      a 30s backstop poll. As soon as the JSONL appears (e.g. the user
   *      finally opens the terminal modal and the `claude` REPL starts
   *      writing), we transition to the live-tail watcher. No timeout —
   *      it sits idle indefinitely, at zero cost.
   *
   * The patient slow path matters because Agor's lifecycle is:
   *   create CLI session → daemon emits `terminal:tab` → user opens
   *   terminal modal → executor spawns the tab → `claude` writes JSONL.
   *
   * The gap between session create and terminal open can be arbitrary
   * (user might create-then-leave). Failing the watcher at 5s was a v0
   * shortcut that this method replaces.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('ClaudeCliWatcher: cannot start a stopped watcher');

    // Fast path: poll for up to ~5s.
    for (let attempt = 0; attempt < FILE_NOT_FOUND_FAST_RETRIES; attempt++) {
      try {
        await fsp.stat(this.jsonlPath);
        return await this.beginTailing();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await sleep(FILE_NOT_FOUND_FAST_BACKOFF_MS);
    }

    // Slow path: file still missing → enter patient-wait mode.
    this.opts.log.info('[claude-cli-watcher] JSONL not yet present, entering patient-wait mode', {
      sessionId: this.opts.sessionId,
      path: this.jsonlPath,
    });
    this.installParentDirWaiter();
  }

  /**
   * Open the JSONL and start the live-tail watcher. Idempotent: safe to
   * call from either the fast-path success branch or the parent-dir
   * waiter when the file finally shows up.
   */
  private async beginTailing(): Promise<void> {
    if (this.stopped) return;
    if (this.watcher) return; // already tailing

    // Tear down any parent-dir waiter — we don't need it anymore.
    this.closeParentDirWaiter();

    // Initial pass over anything already past `startOffset`.
    await this.readAndDispatch();

    // Kernel-driven thereafter. `persistent: false` means this watcher
    // does NOT keep the Node event loop alive on its own — the daemon's
    // primary loop owns that.
    this.watcher = watch(this.jsonlPath, { persistent: false }, () => {
      // Don't await — kernel events can interleave. Chain through
      // `this.busy` so reads serialize.
      this.busy = this.busy
        .then(() => this.readAndDispatch())
        .catch((err) => {
          this.opts.log.error('[claude-cli-watcher] read error', {
            sessionId: this.opts.sessionId,
            err,
          });
        });
    });

    // Schedule the periodic flush. One-shot timer rescheduled after each
    // flush — a true setInterval would over-fire on long-idle sessions.
    this.scheduleFlush();
  }

  /**
   * Stop watching and flush the current offset to the persister.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.closeParentDirWaiter();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.busy;
    await this.persistOffset();
  }

  /**
   * Install the patient-wait mode: an `fs.watch` on the parent slug
   * directory (so we wake up the instant the CLI writes the file's first
   * byte and triggers a `rename` event), backed by a slow poll as a
   * defensive belt-and-suspenders.
   *
   * Idempotent and stoppable via {@link stop} / {@link closeParentDirWaiter}.
   */
  private installParentDirWaiter(): void {
    if (this.stopped) return;
    if (this.parentDirWatcher || this.parentDirPollTimer) return;

    const parentDir = path.dirname(this.jsonlPath);
    const targetBasename = path.basename(this.jsonlPath);

    const tryLatch = () => {
      if (this.stopped || this.watcher) return;
      // Check existence and transition. Errors swallowed — we'll retry on
      // the next kernel event or the poll backstop.
      fsp.stat(this.jsonlPath).then(
        () => {
          if (this.stopped || this.watcher) return;
          this.busy = this.busy
            .then(() => this.beginTailing())
            .catch((err) => {
              this.opts.log.error('[claude-cli-watcher] beginTailing failed', {
                sessionId: this.opts.sessionId,
                err,
              });
            });
        },
        () => {
          /* still not there */
        }
      );
    };

    try {
      // `fs.watch` on a directory fires `rename` for create/delete/rename
      // events on its children. We use `filename` to ignore unrelated
      // siblings in the same slug dir.
      this.parentDirWatcher = watch(parentDir, { persistent: false }, (_event, filename) => {
        if (filename === targetBasename) tryLatch();
      });
    } catch (err) {
      // `parentDir` itself may not yet exist (claude hasn't written any
      // session to this slug). The slow-path poller below will catch it
      // once the dir + file appear; not fatal.
      this.opts.log.debug?.('[claude-cli-watcher] parent dir watch failed (will poll)', {
        sessionId: this.opts.sessionId,
        parentDir,
        err,
      });
    }

    this.parentDirPollTimer = setInterval(tryLatch, PARENT_DIR_CHECK_INTERVAL_MS);
    this.parentDirPollTimer.unref?.();

    // Try once immediately in case a fast-write race let the file appear
    // between the fast-path's last poll and now.
    tryLatch();
  }

  private closeParentDirWaiter(): void {
    if (this.parentDirWatcher) {
      this.parentDirWatcher.close();
      this.parentDirWatcher = null;
    }
    if (this.parentDirPollTimer) {
      clearInterval(this.parentDirPollTimer);
      this.parentDirPollTimer = null;
    }
  }

  private async readAndDispatch(): Promise<void> {
    if (this.stopped) return;

    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(this.jsonlPath);
    } catch (err) {
      // The file may briefly disappear if the user runs `/clear` or the
      // CLI swaps it. Log and try again on next event.
      this.opts.log.warn('[claude-cli-watcher] stat failed', {
        sessionId: this.opts.sessionId,
        err,
      });
      return;
    }

    if (stat.size === this.offset) return; // nothing new
    if (stat.size < this.offset) {
      // File got smaller — either truncated or rotated. Reset to 0 and
      // re-translate from the top. (Rare.)
      this.opts.log.warn('[claude-cli-watcher] file shrank — re-reading from start', {
        sessionId: this.opts.sessionId,
        path: this.jsonlPath,
        old: this.offset,
        new: stat.size,
      });
      this.offset = 0;
      this.lineBuffer = '';
    }

    const fh = await fsp.open(this.jsonlPath, 'r');
    try {
      const readFrom = this.offset;
      const chunkSize = stat.size - readFrom;
      const buf = Buffer.alloc(chunkSize);
      const { bytesRead } = await fh.read(buf, 0, chunkSize, readFrom);

      // Append to held-over fragment, then split. `bufferStartsAt` is the
      // file-byte offset where `combined`'s payload begins — used below to
      // compute the per-line "successful commit" position. The held-over
      // fragment was already counted in a previous tick's read, so the
      // chunk we just read starts at readFrom; `combined` includes those
      // bytes plus the lineBuffer fragment whose byte length we track.
      const fragmentBytes = Buffer.byteLength(this.lineBuffer, 'utf-8');
      const combined = this.lineBuffer + buf.subarray(0, bytesRead).toString('utf-8');
      const lines = combined.split('\n');
      // Last element is either '' (clean newline-terminated read) or a
      // fragment to hold over.
      const trailing = lines.pop() ?? '';

      // ── Offset-on-success-only ──
      //
      // The previous implementation advanced `this.offset` to
      // `readFrom + bytesRead` *before* dispatching the sink, then
      // caught + swallowed sink failures. A transient sink error (DB
      // hiccup, schema drift, etc.) silently lost those JSONL lines —
      // the byte cursor would persist past them and they'd never be
      // re-read.
      //
      // Now we walk line-by-line, advance `this.offset` only after the
      // sink resolves for the full line, and on failure we **break out
      // of the loop**, leaving `this.offset` at the last successful
      // line. The next `fs.watch` tick re-reads the failing line from
      // disk and re-attempts; a persistent failure pauses progress
      // visibly (operator-actionable) instead of dropping data.
      //
      // `lineStart` is the file-byte offset of the line we're about to
      // process. After success we add `byteLength(line) + 1` (for the
      // `\n` terminator we split on).
      let lineStart = readFrom - fragmentBytes;
      let sinkFailed = false;
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf-8');
        const lineEnd = lineStart + lineBytes + 1; // +1 for the consumed \n
        if (!line.trim()) {
          // Blank line: commit position so we don't re-process it on
          // every subsequent tick. Treated as a no-op success.
          this.offset = lineEnd;
          this.lineBuffer = '';
          lineStart = lineEnd;
          continue;
        }
        const events = this.translator.translateLine(line);
        let allSucceeded = true;
        for (const event of events) {
          try {
            if ('uuid' in event && event.uuid) this.lastEventUuid = event.uuid;
            if ('timestamp' in event && event.timestamp) this.lastEventTs = event.timestamp;
            await this.opts.sink(this.opts.sessionId, event);
          } catch (err) {
            this.opts.log.error('[claude-cli-watcher] sink error — stopping at line', {
              sessionId: this.opts.sessionId,
              eventType: event.type,
              byteOffset: lineStart,
              err,
            });
            allSucceeded = false;
            sinkFailed = true;
            break;
          }
        }
        if (!allSucceeded) break;
        // Commit this line: cursor + held-over fragment cleared.
        this.offset = lineEnd;
        this.lineBuffer = '';
        lineStart = lineEnd;
        this.linesSinceFlush++;
        if (this.linesSinceFlush >= this.opts.persistEveryNLines) {
          void this.persistOffset();
        }
      }
      // Only hold the trailing fragment if we processed every line
      // successfully. On sink failure we keep `this.offset` at the
      // failed line's start; the next read re-fetches everything from
      // there (and the fragment, if any, is part of that re-read).
      if (!sinkFailed) {
        this.lineBuffer = trailing;
        // `this.offset` should sit just past the last complete line;
        // bytes for the trailing fragment have been "read" but not
        // "committed" — they live in lineBuffer and will be rejoined on
        // the next read from `this.offset`.
      }
    } finally {
      await fh.close();
    }
  }

  private scheduleFlush(): void {
    if (this.stopped) return;
    this.flushTimer = setTimeout(() => {
      void this.persistOffset().finally(() => this.scheduleFlush());
    }, this.opts.persistEveryMs);
    // Don't hold the event loop open for this timer.
    this.flushTimer?.unref?.();
  }

  private async persistOffset(): Promise<void> {
    this.linesSinceFlush = 0;
    try {
      await this.opts.persister.saveOffset(this.opts.sessionId, {
        watcher_offset: this.offset,
        last_event_ts: this.lastEventTs,
        last_event_uuid: this.lastEventUuid,
      });
    } catch (err) {
      this.opts.log.warn('[claude-cli-watcher] persist failed', {
        sessionId: this.opts.sessionId,
        err,
      });
    }
  }
}

/**
 * Registry of active watchers, keyed by session id. Surfaces the lifecycle
 * the daemon's sessions service drives:
 *
 *   - `register` on `agentic_tool === 'claude-code-cli'` session create
 *   - `register` on daemon startup for every in-flight CLI session row
 *   - `unregister` on session end / PTY exit / archive
 *
 * Implementation note: no global singleton. Daemon wiring constructs and
 * holds one of these in its service container so testing stays clean.
 */
export class ClaudeCliWatcherRegistry {
  private readonly watchers = new Map<SessionID, ClaudeCliWatcher>();

  constructor(
    private readonly persister: CliWatcherStatePersister,
    private readonly sink: CliWatcherEventSink,
    private readonly log: Pick<Console, 'warn' | 'info' | 'error' | 'debug'> = console
  ) {}

  /** Start a watcher for a session. No-op if one already exists. */
  async register(
    args: Omit<CliWatcherOptions, 'persister' | 'sink' | 'log'>
  ): Promise<ClaudeCliWatcher> {
    const existing = this.watchers.get(args.sessionId);
    if (existing) return existing;
    const w = new ClaudeCliWatcher({
      ...args,
      persister: this.persister,
      sink: this.sink,
      log: this.log,
    });
    this.watchers.set(args.sessionId, w);
    try {
      await w.start();
      this.log.info('[claude-cli-watcher] started', {
        sessionId: args.sessionId,
        path: w.path,
        startOffset: args.startOffset ?? 0,
      });
    } catch (err) {
      this.watchers.delete(args.sessionId);
      throw err;
    }
    return w;
  }

  /** Stop + flush a watcher. No-op if none. */
  async unregister(sessionId: SessionID): Promise<void> {
    const w = this.watchers.get(sessionId);
    if (!w) return;
    this.watchers.delete(sessionId);
    await w.stop();
    this.log.info('[claude-cli-watcher] stopped', { sessionId });
  }

  /** Stop every watcher. Called on daemon shutdown. */
  async stopAll(): Promise<void> {
    const sessions = Array.from(this.watchers.keys());
    await Promise.all(sessions.map((id) => this.unregister(id)));
  }

  /** Peek the live watcher for a session — diagnostic / test-only. */
  get(sessionId: SessionID): ClaudeCliWatcher | undefined {
    return this.watchers.get(sessionId);
  }

  /** Count of active watchers — diagnostic. */
  get size(): number {
    return this.watchers.size;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
