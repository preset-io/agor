/**
 * Advisory access answers, and the group memberships behind them, shared by
 * Home's ask box and rail and the teammates directory. This is UI state only: it decides what to show, and the server
 * enforces every action regardless.
 *
 * - One read per key per client and signed-in scope (`accessScope`); a new
 *   scope drops everything, and reads still queued for an old scope never start.
 *   Peeking never changes the scope.
 * - At most `MAX_IN_FLIGHT` reads run at once; the rest queue.
 * - Permission and membership changes emit no event the UI receives, so an
 *   answer older than `ACCESS_TTL_MS` is re-read by the next `readAccess`;
 *   `peekAccess` keeps returning it until then, so nothing flickers.
 * - A failed read is forgotten, so the next caller retries.
 * - A caller's `signal` abandons its wait; a queued read every caller has
 *   abandoned never issues its request.
 */
const MAX_IN_FLIGHT = 4;
export const ACCESS_TTL_MS = 60_000;

interface Known {
  value: unknown;
  at: number;
}

interface PendingRead {
  promise: Promise<unknown>;
  /** Callers still waiting with a signal; a caller without one keeps the read alive. */
  waiters: number;
  pinned: boolean;
  started: boolean;
  cancelled: boolean;
}

interface ScopedReads {
  scope: string;
  reads: Map<string, PendingRead>;
  known: Map<string, Known>;
}

const byClient = new WeakMap<object, ScopedReads>();
let inFlight = 0;
const waiting: (() => void)[] = [];

const acquire = () => {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
};

const release = () => {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
};

const abortError = () => new DOMException('The access read was aborted.', 'AbortError');

/** The signed-in scope answers belong to; a role change re-reads them like a new sign-in. */
export const accessScope = (
  user: { user_id?: string; role?: string } | null | undefined,
  authGeneration: number
) => `${user?.user_id}:${user?.role}:${authGeneration}`;

function scoped(client: object, scope: string) {
  let entry = byClient.get(client);
  if (entry?.scope !== scope) {
    entry = { scope, reads: new Map(), known: new Map() };
    byClient.set(client, entry);
  }
  return entry;
}

/** The last answer this scope has, even past its TTL; undefined until one arrives or for another scope. */
export function peekAccess<T = boolean>(client: object, scope: string, key: string) {
  const entry = byClient.get(client);
  return entry?.scope === scope ? (entry.known.get(key)?.value as T | undefined) : undefined;
}

function startRead(
  client: object,
  entry: ScopedReads,
  key: string,
  read: () => Promise<unknown>
): PendingRead {
  const pending: PendingRead = {
    promise: Promise.resolve(undefined),
    waiters: 0,
    pinned: false,
    started: false,
    cancelled: false,
  };
  pending.promise = acquire().then(async () => {
    try {
      if (pending.cancelled || byClient.get(client) !== entry) throw abortError();
      pending.started = true;
      return await read();
    } finally {
      release();
    }
  });
  pending.promise.then(
    (value) => {
      entry.known.set(key, { value, at: Date.now() });
      if (entry.reads.get(key) === pending) entry.reads.delete(key);
    },
    () => {
      if (entry.reads.get(key) === pending) entry.reads.delete(key);
    }
  );
  return pending;
}

/**
 * The caller's access for `key`, from a fresh answer when there is one, else from
 * the shared read. Rejects with an `AbortError` once `signal` aborts. A key holds
 * one kind of answer (`T`), usually whether the caller may do something.
 */
export function readAccess<T = boolean>(
  client: object,
  scope: string,
  key: string,
  read: () => Promise<T>,
  { signal }: { signal?: AbortSignal } = {}
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  const entry = scoped(client, scope);
  const known = entry.known.get(key);
  if (known && Date.now() - known.at < ACCESS_TTL_MS) return Promise.resolve(known.value as T);
  let pending = entry.reads.get(key);
  if (!pending) {
    pending = startRead(client, entry, key, read);
    entry.reads.set(key, pending);
  }
  if (!signal) {
    pending.pinned = true;
    return pending.promise as Promise<T>;
  }
  const shared = pending;
  shared.waiters++;
  return new Promise<T>((resolve, reject) => {
    const abandon = () => {
      reject(abortError());
      if (--shared.waiters > 0 || shared.pinned || shared.started) return;
      shared.cancelled = true;
      if (entry.reads.get(key) === shared) entry.reads.delete(key);
    };
    signal.addEventListener('abort', abandon, { once: true });
    shared.promise.then(
      (value) => {
        signal.removeEventListener('abort', abandon);
        resolve(value as T);
      },
      (error) => {
        signal.removeEventListener('abort', abandon);
        reject(error);
      }
    );
  });
}
