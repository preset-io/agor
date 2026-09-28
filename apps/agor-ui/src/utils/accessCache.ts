/**
 * Access reads shared by Home's ask box and rail and the teammates directory:
 * one read per key per client and signed-in scope (`user:authGeneration`), at
 * most a few in flight. A new scope drops everything; a failed read is
 * forgotten so the next caller retries.
 */
const MAX_IN_FLIGHT = 4;

interface ScopedReads {
  scope: string;
  reads: Map<string, Promise<boolean>>;
  known: Map<string, boolean>;
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

function scoped(client: object, scope: string) {
  let entry = byClient.get(client);
  if (entry?.scope !== scope) {
    entry = { scope, reads: new Map(), known: new Map() };
    byClient.set(client, entry);
  }
  return entry;
}

/** The settled answer, if this scope already has one. */
export const peekAccess = (client: object, scope: string, key: string) =>
  scoped(client, scope).known.get(key);

export function readAccess(
  client: object,
  scope: string,
  key: string,
  read: () => Promise<boolean>
): Promise<boolean> {
  const entry = scoped(client, scope);
  const pending = entry.reads.get(key);
  if (pending) return pending;
  const result = acquire().then(async () => {
    try {
      return await read();
    } finally {
      release();
    }
  });
  entry.reads.set(key, result);
  result.then(
    (value) => entry.known.set(key, value),
    () => entry.reads.delete(key)
  );
  return result;
}
