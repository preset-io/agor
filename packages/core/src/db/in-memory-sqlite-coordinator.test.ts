import type { Client, InArgs, InStatement, ResultSet } from '@libsql/client';
import { describe, expect, it, vi } from 'vitest';
import { coordinateInMemorySQLiteClient } from './in-memory-sqlite-coordinator';

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
    const transaction = await client['transaction']();
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
    const transaction = await client['transaction']();
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
    const transaction = await client['transaction']();

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
    const transaction = await client['transaction']();

    await expect(transaction.commit()).rejects.toMatchObject({
      message: 'SQLite transaction failed and the connection was reset after rollback failed',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    await expect(client.execute('after connection reset')).resolves.toBe(result);
    expect(order.at(-1)).toBe('after connection reset');
  });
});
