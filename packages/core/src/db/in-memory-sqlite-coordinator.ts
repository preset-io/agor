/**
 * Connection ownership for libsql's literal in-memory databases.
 *
 * A local libsql interactive transaction normally moves the client's native
 * connection into a transaction object. For `:memory:` that makes the base
 * client lazily open a different, empty database. Keeping BEGIN/COMMIT on the
 * original connection fixes that, but is safe only when every use of the
 * client is serialized behind the same ownership boundary.
 *
 * This module decorates the client itself, below Drizzle. Consequently direct
 * Drizzle builders (`run`, `get`, `all`, `execute` and promise execution),
 * repository helpers, batches, migrations, and interactive transactions all
 * pass through one coordinator owned by this client. The coordinator is per
 * handle, never process-global.
 */
import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from '@libsql/client';

interface Coordinator {
  locked: boolean;
  waiters: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void }>;
  activeOwner?: symbol;
  poisoned?: Error;
}

interface OwnedTransactionState {
  phase: 'open' | 'finishing' | 'closed';
  tail: Promise<void>;
  finishing?: Promise<void>;
}

interface DrizzleNestedTransactionScope {
  tail: Promise<void>;
}

const IN_MEMORY_SQLITE_COORDINATOR = Symbol('agor.db.sqlite.in-memory.coordinator');

async function acquire(coordinator: Coordinator): Promise<() => void> {
  if (coordinator.poisoned) throw coordinator.poisoned;
  if (!coordinator.locked) {
    coordinator.locked = true;
    return () => releaseCoordinator(coordinator);
  }
  return new Promise((resolve, reject) => coordinator.waiters.push({ resolve, reject }));
}

function releaseCoordinator(coordinator: Coordinator): void {
  if (coordinator.poisoned) return;
  const next = coordinator.waiters.shift();
  if (next) next.resolve(() => releaseCoordinator(coordinator));
  else coordinator.locked = false;
}

function poisonCoordinator(coordinator: Coordinator, cause: unknown): Error {
  if (!coordinator.poisoned) {
    coordinator.poisoned = new Error(
      'Literal-memory SQLite connection is permanently unavailable after transaction cleanup failed',
      { cause }
    );
    for (const waiter of coordinator.waiters.splice(0)) waiter.reject(coordinator.poisoned);
  }
  return coordinator.poisoned;
}

function statementSql(statement: InStatement | [string, InArgs?]): InStatement {
  return Array.isArray(statement) ? { sql: statement[0], args: statement[1] ?? [] } : statement;
}

function beginStatement(mode: TransactionMode | undefined): string {
  // @libsql/client's no-argument transaction defaults to a write transaction.
  // BEGIN IMMEDIATE retains that behavior and prevents a late write-upgrade
  // race while this handle owns its one physical connection.
  return mode === 'read' || mode === 'deferred' ? 'BEGIN' : 'BEGIN IMMEDIATE';
}

class UnsafeTerminalRecoveryError extends AggregateError {}

async function recoverRollback(raw: Client, primaryError: unknown): Promise<never> {
  const rollbackErrors: unknown[] = [];
  // A deferred-constraint COMMIT failure leaves SQLite's transaction open.
  // Retry a failed rollback once: a transport/client can report a transient
  // terminal error even though the connection remains usable.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await raw.execute('ROLLBACK');
    } catch (error) {
      rollbackErrors.push(error);
      continue;
    }
    if (rollbackErrors.length === 0) throw primaryError;
    throw new AggregateError(
      [primaryError, ...rollbackErrors],
      'SQLite transaction failed; rollback succeeded after a retry'
    );
  }

  // Do not release an open transaction back to the coordinator. If SQLite
  // refuses both rollback attempts, close and reconnect the one literal-memory
  // handle before ownership is released. This is intentionally a last-resort
  // fail-closed path; the caller receives every terminal failure.
  let resetError: unknown;
  try {
    raw.close();
    await raw.reconnect();
  } catch (error) {
    resetError = error;
  }
  const terminal = new AggregateError(
    [primaryError, ...rollbackErrors, ...(resetError === undefined ? [] : [resetError])],
    resetError === undefined
      ? 'SQLite transaction failed and the connection was reset after rollback failed'
      : 'SQLite transaction failed and rollback/connection reset both failed'
  );
  if (resetError !== undefined)
    throw new UnsafeTerminalRecoveryError(terminal.errors, terminal.message);
  throw terminal;
}

async function finishTransaction(
  raw: Client,
  coordinator: Coordinator,
  owner: symbol,
  state: OwnedTransactionState,
  release: () => void,
  command: 'COMMIT' | 'ROLLBACK'
): Promise<void> {
  if (coordinator.poisoned) throw coordinator.poisoned;
  if (state.phase === 'closed') return;
  if (state.finishing) return state.finishing;
  // Close the admission gate synchronously. Anything accepted before this
  // point is represented by `tail`; anything later is rejected immediately.
  state.phase = 'finishing';
  // Wait for every statement already accepted by this transaction. Statements
  // are serialized because libsql's one native connection cannot safely run
  // two operations at once.
  state.finishing = (async () => {
    await state.tail;
    let safeToRelease = true;
    try {
      if (command === 'COMMIT') {
        try {
          await raw.execute('COMMIT');
        } catch (commitError) {
          await recoverRollback(raw, commitError);
        }
      } else {
        try {
          await raw.execute('ROLLBACK');
        } catch (rollbackError) {
          await recoverRollback(raw, rollbackError);
        }
      }
    } catch (error) {
      if (error instanceof UnsafeTerminalRecoveryError) {
        safeToRelease = false;
        throw poisonCoordinator(coordinator, error);
      }
      throw error;
    } finally {
      // `recoverRollback` returns only by throwing after rollback or a hard
      // connection reset has completed, so no raw open transaction is ever
      // released through this finally block.
      state.phase = 'closed';
      if (safeToRelease) {
        if (coordinator.activeOwner === owner) coordinator.activeOwner = undefined;
        release();
      }
    }
  })();
  return state.finishing;
}

function createOwnedTransaction(
  raw: Client,
  coordinator: Coordinator,
  owner: symbol,
  release: () => void
): Transaction {
  const state: OwnedTransactionState = { phase: 'open', tail: Promise.resolve() };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (coordinator.poisoned) return Promise.reject(coordinator.poisoned);
    if (state.phase !== 'open') {
      return Promise.reject(
        new Error(
          state.phase === 'finishing' ? 'Transaction is finishing' : 'Transaction is closed'
        )
      );
    }
    const result = state.tail.then(operation);
    // A rejected statement must not poison the serialization chain: callers
    // may still explicitly roll the transaction back.
    state.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    get closed() {
      return state.phase === 'closed';
    },
    execute: (statement) => enqueue(() => raw.execute(statement)),
    batch: (statements) =>
      enqueue(async () => {
        const results: ResultSet[] = [];
        for (const statement of statements) results.push(await raw.execute(statement));
        return results;
      }),
    executeMultiple: (source) => enqueue(() => raw.executeMultiple(source)),
    commit: () => finishTransaction(raw, coordinator, owner, state, release, 'COMMIT'),
    rollback: () => finishTransaction(raw, coordinator, owner, state, release, 'ROLLBACK'),
    close: () => {
      if (state.phase === 'open') {
        // The Client contract makes close synchronous. Queue rollback behind
        // accepted statements and retain ownership until it completes. There
        // is no asynchronous error channel on close; terminal cleanup still
        // completes fail-closed, while its rejection is deliberately observed
        // rather than becoming an unhandled promise rejection.
        void finishTransaction(raw, coordinator, owner, state, release, 'ROLLBACK').catch(
          () => undefined
        );
      }
    },
  };
}

async function runBatch(
  raw: Client,
  coordinator: Coordinator,
  statements: Array<InStatement | [string, InArgs?]>,
  mode?: TransactionMode
): Promise<ResultSet[]> {
  await raw.execute(beginStatement(mode));
  try {
    const results: ResultSet[] = [];
    for (const statement of statements) results.push(await raw.execute(statementSql(statement)));
    await raw.execute('COMMIT');
    return results;
  } catch (error) {
    try {
      return await recoverRollback(raw, error);
    } catch (terminal) {
      if (terminal instanceof UnsafeTerminalRecoveryError) {
        throw poisonCoordinator(coordinator, terminal);
      }
      throw terminal;
    }
  }
}

async function acquireNestedScope(scope: DrizzleNestedTransactionScope): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = scope.tail;
  scope.tail = previous.then(() => gate);
  await previous;
  return release;
}

type DrizzleTransactionCallback = (transaction: unknown) => unknown | Promise<unknown>;
type DrizzleTransactionMethod = (
  callback: DrizzleTransactionCallback,
  config?: unknown
) => Promise<unknown>;

function coordinateDrizzleTransactionHandle<T extends object>(raw: T, coordinator: Coordinator): T {
  const scope: DrizzleNestedTransactionScope = { tail: Promise.resolve() };
  return new Proxy(raw, {
    get(target, property) {
      if (property === 'transaction') {
        const transaction = Reflect.get(target, property, target) as DrizzleTransactionMethod;
        return async (callback: DrizzleTransactionCallback, config?: unknown) => {
          if (coordinator.poisoned) throw coordinator.poisoned;
          // Drizzle uses a savepoint name derived only from nesting depth. Two
          // sibling callbacks therefore both use `sp0`; serialize the complete
          // callbacks so one sibling's rollback can never erase another one's
          // successful release.
          const release = await acquireNestedScope(scope);
          try {
            if (coordinator.poisoned) throw coordinator.poisoned;
            return await transaction.call(
              target,
              (nested) =>
                callback(coordinateDrizzleTransactionHandle(nested as object, coordinator)),
              config
            );
          } finally {
            release();
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}

/**
 * Decorate Drizzle's literal-memory database handle as well as its libsql
 * client. The driver coordinator owns the physical connection; this layer is
 * the only place where the full nested callback lifetime is visible, so it
 * serializes sibling savepoints for callers of Drizzle's direct transaction
 * method too.
 */
export function coordinateInMemorySQLiteDatabase<T extends object>(raw: T, client: Client): T {
  const coordinator = (client as unknown as Record<PropertyKey, unknown>)[
    IN_MEMORY_SQLITE_COORDINATOR
  ] as Coordinator;
  if (!coordinator) {
    throw new Error('Literal-memory SQLite database requires its coordinated client');
  }
  return new Proxy(raw, {
    get(target, property) {
      if (property === 'transaction') {
        const transaction = Reflect.get(target, property, target) as DrizzleTransactionMethod;
        return (callback: DrizzleTransactionCallback, config?: unknown) =>
          coordinator.poisoned
            ? Promise.reject(coordinator.poisoned)
            : transaction.call(
                target,
                (tx) => callback(coordinateDrizzleTransactionHandle(tx as object, coordinator)),
                config
              );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}

/** Decorate one literal-memory client so no Drizzle path can bypass ownership. */
export function coordinateInMemorySQLiteClient(raw: Client): Client {
  const coordinator: Coordinator = { locked: false, waiters: [] };

  const coordinated = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = await acquire(coordinator);
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return new Proxy(raw, {
    get(target, property) {
      if (property === IN_MEMORY_SQLITE_COORDINATOR) return coordinator;
      switch (property) {
        case 'execute':
          return (statement: InStatement | string, args?: InArgs) =>
            coordinated(() =>
              typeof statement === 'string'
                ? target.execute(statement, args)
                : target.execute(statement)
            );
        case 'batch':
          return (statements: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode) =>
            coordinated(() => runBatch(target, coordinator, statements, mode));
        case 'migrate':
          return (statements: InStatement[]) =>
            coordinated(async () => {
              try {
                await target.execute('PRAGMA foreign_keys = OFF');
              } catch (error) {
                // The statement may have reached SQLite even when the client
                // reported failure. Never admit work on a handle whose FK
                // enforcement state cannot be proven.
                throw poisonCoordinator(coordinator, error);
              }
              let outcome: { ok: true; value: ResultSet[] } | { ok: false; error: unknown };
              try {
                outcome = {
                  ok: true,
                  value: await runBatch(target, coordinator, statements, 'deferred'),
                };
              } catch (error) {
                outcome = { ok: false, error };
              }

              // A poison means terminal recovery could not prove the raw
              // connection clean. Do not dispatch even a cleanup PRAGMA on
              // that handle, and preserve the one stable poison identity.
              if (coordinator.poisoned) throw coordinator.poisoned;
              try {
                await target.execute('PRAGMA foreign_keys = ON');
              } catch (error) {
                if (coordinator.poisoned) throw coordinator.poisoned;
                throw poisonCoordinator(
                  coordinator,
                  outcome.ok
                    ? error
                    : new AggregateError(
                        [outcome.error, error],
                        'SQLite migration and foreign-key cleanup both failed'
                      )
                );
              }
              if (!outcome.ok) throw outcome.error;
              return outcome.value;
            });
        case 'executeMultiple':
          return (source: string) => coordinated(() => target.executeMultiple(source));
        case 'sync':
          return () => coordinated(() => target.sync());
        case 'transaction':
          return async (mode?: TransactionMode): Promise<Transaction> => {
            const release = await acquire(coordinator);
            const owner = Symbol('literal-memory-sqlite-transaction');
            coordinator.activeOwner = owner;
            try {
              await target.execute(beginStatement(mode));
              return createOwnedTransaction(target, coordinator, owner, release);
            } catch (error) {
              coordinator.activeOwner = undefined;
              release();
              throw error;
            }
          };
        default: {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      }
    },
  }) as Client;
}
