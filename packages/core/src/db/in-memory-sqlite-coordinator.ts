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
  tail: Promise<void>;
  activeOwner?: symbol;
}

interface OwnedTransactionState {
  closed: boolean;
  tail: Promise<void>;
  finishing?: Promise<void>;
}

async function acquire(coordinator: Coordinator): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = coordinator.tail;
  coordinator.tail = previous.then(() => gate);
  await previous;
  return release;
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

async function finishTransaction(
  raw: Client,
  coordinator: Coordinator,
  owner: symbol,
  state: OwnedTransactionState,
  release: () => void,
  command: 'COMMIT' | 'ROLLBACK'
): Promise<void> {
  if (state.closed) return;
  if (state.finishing) return state.finishing;
  // Wait for every statement already accepted by this transaction. Statements
  // are serialized because libsql's one native connection cannot safely run
  // two operations at once.
  state.finishing = (async () => {
    await state.tail;
    try {
      await raw.execute(command);
    } finally {
      state.closed = true;
      if (coordinator.activeOwner === owner) coordinator.activeOwner = undefined;
      release();
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
  const state: OwnedTransactionState = { closed: false, tail: Promise.resolve() };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (state.closed) return Promise.reject(new Error('Transaction is closed'));
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
      return state.closed;
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
      if (!state.closed) {
        // The Client contract makes close synchronous. Queue rollback behind
        // accepted statements and retain ownership until it completes.
        void finishTransaction(raw, coordinator, owner, state, release, 'ROLLBACK');
      }
    },
  };
}

async function runBatch(
  raw: Client,
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
      await raw.execute('ROLLBACK');
    } catch {
      // Preserve the statement failure.
    }
    throw error;
  }
}

/** Decorate one literal-memory client so no Drizzle path can bypass ownership. */
export function coordinateInMemorySQLiteClient(raw: Client): Client {
  const coordinator: Coordinator = { tail: Promise.resolve() };

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
            coordinated(() => runBatch(target, statements, mode));
        case 'migrate':
          return (statements: InStatement[]) =>
            coordinated(async () => {
              await target.execute('PRAGMA foreign_keys = OFF');
              try {
                return await runBatch(target, statements, 'deferred');
              } finally {
                await target.execute('PRAGMA foreign_keys = ON');
              }
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
