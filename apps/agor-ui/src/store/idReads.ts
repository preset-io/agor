/**
 * Reads by id: the user scope's referenced branches and the rows a view
 * ensures (`useEnsureRows`). Ids are queued, sent in chunks of
 * `PAGINATION.MAX_ID_LIST`, at most `MAX_CONCURRENT_ID_READS` at once, and a
 * failed chunk is retried with capped backoff, up to `MAX_ID_READ_ATTEMPTS`.
 */
import { PAGINATION } from '@agor-live/client';

/** Id-list reads in flight at once, per reader. */
export const MAX_CONCURRENT_ID_READS = 3;
/** Attempts a failed id read gets before its ids count as failed. */
export const MAX_ID_READ_ATTEMPTS = 6;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
/** Delay before retry `attempt` (1-based) of a failed read: capped exponential backoff. */
export const idReadRetryDelayMs = (attempt: number) =>
  Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);

/** The rows of a `find` result, paginated or not. */
export const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : ((result as { data?: T[] })?.data ?? []);

export interface IdReaderOptions {
  /**
   * Read and apply one chunk. Resolves the ids the server returned, or `null`
   * when the read was dropped (its load no longer current); throws on failure.
   */
  read: (chunk: string[]) => Promise<ReadonlySet<string> | null>;
  /** Whether the reader still runs; nothing is sent or settled once false (or disposed). */
  isCurrent: () => boolean;
  /** After a chunk settles, fails for good, or is requeued. */
  onChange?: () => void;
  /** The ids of a failed chunk to read again (default: all of them). */
  retry?: (ids: string[]) => string[];
}

export interface IdReader {
  /** Queue ids; one queued, in flight or awaiting a retry is not asked for twice. */
  queue(ids: Iterable<string>): void;
  /** Ids queued, in flight or awaiting a retry. */
  readonly pending: ReadonlySet<string>;
  /** Ids the server didn't return. */
  readonly absent: ReadonlySet<string>;
  /** Ids whose every attempt failed. */
  readonly failed: ReadonlySet<string>;
  /** Forget what the reader knows of `ids` (absent, failed, attempts). */
  forget(ids: Iterable<string>): void;
  /** Resolves once nothing is queued or in flight (a retry waiting doesn't count). */
  drained(): Promise<void>;
  /** Stop for good: cancel retries, drop the queue, and send or settle nothing more. */
  dispose(): void;
}

export function createIdReader({
  read,
  isCurrent: current,
  onChange,
  retry = (ids) => ids,
}: IdReaderOptions): IdReader {
  let disposed = false;
  const isCurrent = () => !disposed && current();
  let queue: string[] = [];
  let inflight = 0;
  const pending = new Set<string>();
  const absent = new Set<string>();
  const failed = new Set<string>();
  const attempts = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const waiters: Array<() => void> = [];
  const release = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  const idle = () => inflight === 0 && queue.length === 0;

  const settle = (chunk: string[], returned: ReadonlySet<string> | null) => {
    for (const id of chunk) pending.delete(id);
    // Dropped, not absent: read again while the reader still runs.
    if (!returned) return reader.queue(chunk);
    for (const id of chunk) {
      attempts.delete(id);
      if (returned.has(id)) absent.delete(id);
      else absent.add(id);
    }
  };

  const fail = (chunk: string[]) => {
    const attempt = Math.max(...chunk.map((id) => (attempts.get(id) ?? 0) + 1));
    for (const id of chunk) attempts.set(id, attempt);
    if (attempt >= MAX_ID_READ_ATTEMPTS) {
      for (const id of chunk) {
        pending.delete(id);
        failed.add(id);
      }
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!isCurrent()) return;
      for (const id of chunk) pending.delete(id);
      reader.queue(retry(chunk));
      onChange?.();
    }, idReadRetryDelayMs(attempt));
    timers.add(timer);
  };

  const pump = () => {
    while (isCurrent() && inflight < MAX_CONCURRENT_ID_READS && queue.length > 0) {
      const chunk = queue.splice(0, PAGINATION.MAX_ID_LIST);
      inflight += 1;
      read(chunk)
        .then(
          (returned) => isCurrent() && settle(chunk, returned),
          (err) => {
            if (!isCurrent()) return;
            console.warn('[idReads] read by id failed:', err);
            fail(chunk);
          }
        )
        .finally(() => {
          inflight -= 1;
          pump();
          if (isCurrent()) onChange?.();
          if (idle()) release();
        });
    }
  };

  const reader: IdReader = {
    queue(ids) {
      for (const id of ids) {
        if (pending.has(id)) continue;
        pending.add(id);
        failed.delete(id);
        queue.push(id);
      }
      pump();
    },
    pending,
    absent,
    failed,
    forget(ids) {
      for (const id of ids) {
        absent.delete(id);
        failed.delete(id);
        attempts.delete(id);
      }
    },
    drained: () =>
      !isCurrent() || idle() ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)),
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      queue = [];
      release();
    },
  };
  return reader;
}
