import type { Client, InArgs, InStatement, ResultSet } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it, vi } from 'vitest';
import {
  coordinateInMemorySQLiteClient,
  coordinateInMemorySQLiteDatabase,
} from './in-memory-sqlite-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const result = { columns: [], rows: [], rowsAffected: 0 } as unknown as ResultSet;

function statementText(statement: InStatement | string): string {
  return typeof statement === 'string' ? statement : statement.sql;
}

function fakeClient(
  execute: (statement: InStatement | string, args?: InArgs) => Promise<ResultSet>
) {
  const close = vi.fn();
  const reconnect = vi.fn(async () => undefined);
  const raw = {
    execute: vi.fn(execute),
    batch: vi.fn(async () => []),
    migrate: vi.fn(async () => []),
    transaction: vi.fn(async () => {
      throw new Error('native transaction must not be used');
    }),
    executeMultiple: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
    close,
    reconnect,
    closed: false,
    protocol: 'file',
  } as unknown as Client;
  return { raw, close, reconnect };
}

describe('literal-memory SQLite interactive transaction terminal ownership', () => {
  it('closes admission before COMMIT and waits for every previously accepted operation', async () => {
    const held = deferred<ResultSet>();
    const order: string[] = [];
    const { raw } = fakeClient(async (statement) => {
      const text = statementText(statement);
      order.push(text);
      return text === 'held statement' ? held.promise : result;
    });
    const client = coordinateInMemorySQLiteClient(raw);
    const transaction = await client.transaction();
    const accepted = transaction.execute('held statement');
    await Promise.resolve();

    const commit = transaction.commit();
    await expect(transaction.execute('late statement')).rejects.toThrow('Transaction is finishing');
    const outside = client.execute('outside statement');
    await Promise.resolve();
    expect(order).toEqual(['BEGIN IMMEDIATE', 'held statement']);
    expect(transaction.closed).toBe(false);

    held.resolve(result);
    await accepted;
    await commit;
    await outside;
    expect(order).toEqual(['BEGIN IMMEDIATE', 'held statement', 'COMMIT', 'outside statement']);
    expect(transaction.closed).toBe(true);
  });

  it('rolls back a failed COMMIT before releasing a waiting base query', async () => {
    const rollback = deferred<ResultSet>();
    const order: string[] = [];
    const commitError = new Error('deferred foreign key failed');
    const { raw } = fakeClient(async (statement) => {
      const text = statementText(statement);
      order.push(text);
      if (text === 'COMMIT') throw commitError;
      if (text === 'ROLLBACK') return rollback.promise;
      return result;
    });
    const client = coordinateInMemorySQLiteClient(raw);
    const transaction = await client.transaction();
    const commit = transaction.commit();
    const outside = client.execute('after failed commit');

    await vi.waitFor(() => expect(order).toContain('ROLLBACK'));
    expect(order).not.toContain('after failed commit');
    expect(transaction.closed).toBe(false);
    rollback.resolve(result);

    await expect(commit).rejects.toBe(commitError);
    await outside;
    expect(order).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK', 'after failed commit']);
    expect(transaction.closed).toBe(true);
  });

  it('reports a rollback failure after a successful retry and releases cleanly', async () => {
    const order: string[] = [];
    let rollbackAttempts = 0;
    const { raw, close, reconnect } = fakeClient(async (statement) => {
      const text = statementText(statement);
      order.push(text);
      if (text === 'COMMIT') throw new Error('commit failed');
      if (text === 'ROLLBACK' && ++rollbackAttempts === 1) {
        throw new Error('rollback transport blip');
      }
      return result;
    });
    const client = coordinateInMemorySQLiteClient(raw);
    const transaction = await client.transaction();

    await expect(transaction.commit()).rejects.toMatchObject({
      message: 'SQLite transaction failed; rollback succeeded after a retry',
    });
    await expect(client.execute('after rollback retry')).resolves.toBe(result);
    expect(order).toEqual([
      'BEGIN IMMEDIATE',
      'COMMIT',
      'ROLLBACK',
      'ROLLBACK',
      'after rollback retry',
    ]);
    expect(close).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('hard-resets the handle if rollback cannot close the raw transaction', async () => {
    const order: string[] = [];
    const { raw, close, reconnect } = fakeClient(async (statement) => {
      const text = statementText(statement);
      order.push(text);
      if (text === 'COMMIT') throw new Error('commit failed');
      if (text === 'ROLLBACK') throw new Error('rollback failed');
      return result;
    });
    const client = coordinateInMemorySQLiteClient(raw);
    const transaction = await client.transaction();

    await expect(transaction.commit()).rejects.toMatchObject({
      message: 'SQLite transaction failed and the connection was reset after rollback failed',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    await expect(client.execute('after connection reset')).resolves.toBe(result);
    expect(order.at(-1)).toBe('after connection reset');
  });

  it('permanently poisons and drains waiters when reset cannot be proven', async () => {
    const order: string[] = [];
    const { raw, reconnect } = fakeClient(async (statement) => {
      const text = statementText(statement);
      order.push(text);
      if (text === 'COMMIT') throw new Error('commit failed');
      if (text === 'ROLLBACK') throw new Error('rollback failed');
      return result;
    });
    reconnect.mockRejectedValueOnce(new Error('reconnect failed'));
    const client = coordinateInMemorySQLiteClient(raw);
    const transaction = await client.transaction();
    const commit = transaction.commit();
    const queued = client.execute('queued outside');
    const queuedBatch = client.batch(['queued batch']);

    let poison!: Error;
    try {
      await commit;
      throw new Error('expected permanent poison');
    } catch (error) {
      poison = error as Error;
    }
    expect(poison.message).toContain('permanently unavailable');
    await expect(queued).rejects.toBe(poison);
    await expect(queuedBatch).rejects.toBe(poison);
    await expect(transaction.execute('poisoned transaction')).rejects.toBe(poison);
    await expect(transaction.batch(['poisoned transaction batch'])).rejects.toBe(poison);
    await expect(transaction.executeMultiple('poisoned transaction script')).rejects.toBe(poison);
    await expect(transaction.commit()).rejects.toBe(poison);
    await expect(transaction.rollback()).rejects.toBe(poison);
    expect(transaction.closed).toBe(true);
    await expect(client.execute('future outside')).rejects.toBe(poison);
    await expect(client.batch(['future batch'])).rejects.toBe(poison);
    await expect(client.executeMultiple('future script')).rejects.toBe(poison);
    await expect(client.migrate([])).rejects.toBe(poison);
    await expect(client.sync()).rejects.toBe(poison);
    await expect(client.transaction()).rejects.toBe(poison);
    expect(order).not.toContain('queued outside');
    expect(order).not.toContain('queued batch');
    expect(order).not.toContain('future outside');
    expect(order).not.toContain('future batch');
    expect(order).not.toContain('future script');
    expect(order).not.toContain('poisoned transaction');
    expect(order).not.toContain('poisoned transaction batch');
    expect(order).not.toContain('poisoned transaction script');
  });

  it('exposes one poison through direct Drizzle transactions, nested handles, and builder causes', async () => {
    const order: string[] = [];
    let failTerminalCleanup = false;
    const { raw, reconnect } = fakeClient(async (statement) => {
      const text = statementText(statement);
      order.push(text);
      if (failTerminalCleanup && (text === 'COMMIT' || text === 'ROLLBACK')) {
        throw new Error(`${text} failed`);
      }
      return result;
    });
    reconnect.mockRejectedValueOnce(new Error('reconnect failed'));
    const client = coordinateInMemorySQLiteClient(raw);
    const db = coordinateInMemorySQLiteDatabase(drizzle(client), client);
    let completedTransaction!: Parameters<Parameters<typeof db.transaction>[0]>[0];
    await db.transaction(async (transaction) => {
      completedTransaction = transaction;
    });

    failTerminalCleanup = true;
    const poisoningTransaction = await client.transaction();
    let poison!: Error;
    try {
      await poisoningTransaction.commit();
      throw new Error('expected permanent poison');
    } catch (error) {
      poison = error as Error;
    }
    const dispatchedBeforeFutureWork = order.length;

    await expect(db.transaction(async () => undefined)).rejects.toBe(poison);
    await expect(completedTransaction.transaction(async () => undefined)).rejects.toBe(poison);
    let builderError!: Error;
    try {
      await db.run(sql.raw('future builder'));
      throw new Error('expected poisoned builder rejection');
    } catch (error) {
      builderError = error as Error;
    }
    expect(builderError === poison || builderError.cause === poison).toBe(true);
    expect(order).toHaveLength(dispatchedBeforeFutureWork);
  });

  it('does not run migration cleanup after poisoning or mask the stable poison', async () => {
    const order: string[] = [];
    const { raw, reconnect } = fakeClient(async (statement) => {
      const text = statementText(statement);
      order.push(text);
      if (text === 'migration statement') throw new Error('migration failed');
      if (text === 'ROLLBACK') throw new Error('rollback failed');
      return result;
    });
    reconnect.mockRejectedValueOnce(new Error('reconnect failed'));
    const client = coordinateInMemorySQLiteClient(raw);
    let poison!: Error;
    try {
      await client.migrate([{ sql: 'migration statement', args: [] }]);
      throw new Error('expected permanent poison');
    } catch (error) {
      poison = error as Error;
    }

    expect(poison.message).toContain('permanently unavailable');
    expect(order).toEqual([
      'PRAGMA foreign_keys = OFF',
      'BEGIN',
      'migration statement',
      'ROLLBACK',
      'ROLLBACK',
    ]);
    await expect(client.migrate([])).rejects.toBe(poison);
  });

  it('poisons when migration PRAGMA cleanup cannot prove foreign keys are restored', async () => {
    const order: string[] = [];
    const { raw } = fakeClient(async (statement) => {
      const text = statementText(statement);
      order.push(text);
      if (text === 'PRAGMA foreign_keys = ON') throw new Error('cleanup transport failed');
      return result;
    });
    const client = coordinateInMemorySQLiteClient(raw);
    let poison!: Error;
    try {
      await client.migrate([]);
      throw new Error('expected permanent poison');
    } catch (error) {
      poison = error as Error;
    }

    expect(poison.message).toContain('permanently unavailable');
    expect(order).toEqual([
      'PRAGMA foreign_keys = OFF',
      'BEGIN',
      'COMMIT',
      'PRAGMA foreign_keys = ON',
    ]);
    await expect(client.execute('after failed PRAGMA cleanup')).rejects.toBe(poison);
    expect(order).not.toContain('after failed PRAGMA cleanup');
  });
});
