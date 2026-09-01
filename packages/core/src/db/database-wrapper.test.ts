import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { createDatabaseAsync } from './client';
import { dateTruncUtc, rawRows, rawRowsAffected, runDatabaseTransaction } from './database-wrapper';
import { runMigrations } from './migrate';
import { AppVariableRepository } from './repositories/app-variables';
import { tasks } from './schema.postgres';
import * as sqliteSchema from './schema.sqlite';

const sqliteAppVariables = sqliteSchema.appVariables;
type SQLiteDatabase = LibSQLDatabase<typeof sqliteSchema>;

function asSQLite(db: unknown): SQLiteDatabase {
  return db as SQLiteDatabase;
}

import { dbTest } from './test-helpers';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function memoryDatabase() {
  const db = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(db);
  return asSQLite(db);
}

function directVariable(key: string, value: string) {
  const now = new Date();
  return {
    variable_id: randomUUID(),
    namespace: 'direct-isolation',
    key,
    value_text: value,
    value_encrypted: null,
    is_encrypted: false,
    content_type: 'text/plain',
    metadata: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
  };
}

describe('dateTruncUtc', () => {
  it('inlines validated PostgreSQL bucket units so SELECT/GROUP BY expressions match', () => {
    const fakePostgresDb = {} as Parameters<typeof dateTruncUtc>[0];
    const bucketExpr = dateTruncUtc(fakePostgresDb, tasks.created_at, 'week');
    const query = sql`select ${bucketExpr} as bucket from ${tasks} group by ${bucketExpr}`;

    const rendered = new PgDialect().sqlToQuery(query);

    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain("date_trunc('week'");
    expect(rendered.sql).not.toContain('date_trunc($');
  });
});

describe('raw query result normalization', () => {
  it('normalizes direct arrays and wrapped rows', () => {
    expect(rawRows([{ id: 'direct' }])).toEqual([{ id: 'direct' }]);
    expect(rawRows({ rows: [{ id: 'wrapped' }] })).toEqual([{ id: 'wrapped' }]);
    expect(rawRows(undefined)).toEqual([]);
  });

  it('normalizes mutation metadata before falling back to returned row count', () => {
    expect(rawRowsAffected({ rowCount: 3 })).toBe(3);
    expect(rawRowsAffected({ rowsAffected: 2 })).toBe(2);
    expect(rawRowsAffected(Object.assign([{ id: 'returned' }], { count: 4 }))).toBe(4);
    expect(rawRowsAffected([{ id: 'returned' }])).toBe(1);
  });
});

describe('literal-memory SQLite transaction ownership', () => {
  it('excludes a direct base Drizzle insert from a paused rollback', async () => {
    const db = await memoryDatabase();
    const entered = deferred();
    const finish = deferred();
    const transaction = db['transaction'](async (tx) => {
      await tx.insert(sqliteAppVariables).values(directVariable('tx-direct', 'discard')).run();
      entered.resolve();
      await finish.promise;
      throw new Error('direct rollback');
    });
    await entered.promise;

    let outsideFinished = false;
    const outside = db
      .insert(sqliteAppVariables)
      .values(directVariable('base-direct', 'keep'))
      .run()
      .then(() => {
        outsideFinished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outsideFinished).toBe(false);

    finish.resolve();
    await expect(transaction).rejects.toThrow('direct rollback');
    await outside;
    await expect(
      db.select().from(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'tx-direct')).get()
    ).resolves.toBeUndefined();
    await expect(
      db.select().from(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'base-direct')).get()
    ).resolves.toMatchObject({ value_text: 'keep' });
  });

  it('excludes an unrelated base insert until rollback has finished', async () => {
    const db = await memoryDatabase();
    const entered = deferred();
    const finish = deferred();
    const tx = runDatabaseTransaction(db, async (transaction) => {
      await new AppVariableRepository(transaction).set({
        namespace: 'isolation',
        key: 'rolled-back',
        value: 'tx',
      });
      entered.resolve();
      await finish.promise;
      throw new Error('rollback requested');
    });
    await entered.promise;

    let outsideFinished = false;
    const outside = new AppVariableRepository(db)
      .set({ namespace: 'isolation', key: 'outside', value: 'base' })
      .then(() => {
        outsideFinished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outsideFinished).toBe(false);

    finish.resolve();
    await expect(tx).rejects.toThrow('rollback requested');
    await outside;
    const repository = new AppVariableRepository(db);
    await expect(repository.getPlain('isolation', 'rolled-back')).resolves.toBeNull();
    await expect(repository.getPlain('isolation', 'outside')).resolves.toBe('base');
  });

  it('does not let an unrelated base insert finish or commit the active transaction', async () => {
    const db = await memoryDatabase();
    const entered = deferred();
    const finish = deferred();
    let transactionCommitted = false;
    const tx = runDatabaseTransaction(db, async (transaction) => {
      await new AppVariableRepository(transaction).set({
        namespace: 'isolation',
        key: 'committed',
        value: 'tx',
      });
      entered.resolve();
      await finish.promise;
    }).then(() => {
      transactionCommitted = true;
    });
    await entered.promise;

    let outsideObservedCommit = false;
    const outside = new AppVariableRepository(db)
      .set({ namespace: 'isolation', key: 'after-commit', value: 'base' })
      .then(() => {
        outsideObservedCommit = transactionCommitted;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transactionCommitted).toBe(false);
    expect(outsideObservedCommit).toBe(false);

    finish.resolve();
    await Promise.all([tx, outside]);
    expect(outsideObservedCommit).toBe(true);
    const repository = new AppVariableRepository(db);
    await expect(repository.getPlain('isolation', 'committed')).resolves.toBe('tx');
    await expect(repository.getPlain('isolation', 'after-commit')).resolves.toBe('base');
  });

  it('serializes concurrent transactions and releases ownership after errors', async () => {
    const db = await memoryDatabase();
    const entered = deferred();
    const finish = deferred();
    const order: string[] = [];
    const first = runDatabaseTransaction(db, async (transaction) => {
      order.push('first-enter');
      await new AppVariableRepository(transaction).set({
        namespace: 'isolation',
        key: 'first',
        value: 'discard',
      });
      entered.resolve();
      await finish.promise;
      order.push('first-error');
      throw new Error('first failed');
    });
    await entered.promise;
    const second = runDatabaseTransaction(db, async (transaction) => {
      order.push('second-enter');
      await new AppVariableRepository(transaction).set({
        namespace: 'isolation',
        key: 'second',
        value: 'kept',
      });
      order.push('second-exit');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first-enter']);

    finish.resolve();
    await expect(first).rejects.toThrow('first failed');
    await second;
    expect(order).toEqual(['first-enter', 'first-error', 'second-enter', 'second-exit']);
    const repository = new AppVariableRepository(db);
    await expect(repository.getPlain('isolation', 'first')).resolves.toBeNull();
    await expect(repository.getPlain('isolation', 'second')).resolves.toBe('kept');
  });

  it('uses savepoints for reentrant transaction-scoped work without deadlock', async () => {
    const db = await memoryDatabase();
    await runDatabaseTransaction(db, async (outer) => {
      await new AppVariableRepository(outer).set({
        namespace: 'nested',
        key: 'outer-before',
        value: 'kept',
      });
      await expect(
        runDatabaseTransaction(outer, async (inner) => {
          await new AppVariableRepository(inner).set({
            namespace: 'nested',
            key: 'inner',
            value: 'discard',
          });
          throw new Error('inner failed');
        })
      ).rejects.toThrow('inner failed');
      await new AppVariableRepository(outer).set({
        namespace: 'nested',
        key: 'outer-after',
        value: 'kept',
      });
    });

    const repository = new AppVariableRepository(db);
    await expect(repository.getPlain('nested', 'outer-before')).resolves.toBe('kept');
    await expect(repository.getPlain('nested', 'inner')).resolves.toBeNull();
    await expect(repository.getPlain('nested', 'outer-after')).resolves.toBe('kept');
  });

  it('serializes sibling savepoints so a paused rollback cannot erase a sibling commit', async () => {
    const db = await memoryDatabase();
    const entered = deferred();
    const finish = deferred();
    const order: string[] = [];

    await db['transaction'](async (outer) => {
      const first = outer['transaction'](async (nested) => {
        order.push('a-enter');
        await nested
          .insert(sqliteAppVariables)
          .values(directVariable('sibling-a', 'discard'))
          .run();
        entered.resolve();
        await finish.promise;
        order.push('a-rollback');
        throw new Error('rollback sibling A');
      });
      await entered.promise;
      const second = outer['transaction'](async (nested) => {
        order.push('b-enter');
        await nested.insert(sqliteAppVariables).values(directVariable('sibling-b', 'keep')).run();
        order.push('b-commit');
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(order).toEqual(['a-enter']);
      finish.resolve();
      await expect(first).rejects.toThrow('rollback sibling A');
      await second;
    });

    expect(order).toEqual(['a-enter', 'a-rollback', 'b-enter', 'b-commit']);
    await expect(
      db.select().from(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'sibling-a')).get()
    ).resolves.toBeUndefined();
    await expect(
      db.select().from(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'sibling-b')).get()
    ).resolves.toMatchObject({ value_text: 'keep' });
  });

  it('serializes the inverse sibling outcome without rolling back an earlier commit', async () => {
    const db = await memoryDatabase();
    const entered = deferred();
    const finish = deferred();
    const order: string[] = [];

    await db['transaction'](async (outer) => {
      const first = outer['transaction'](async (nested) => {
        order.push('a-enter');
        await nested.insert(sqliteAppVariables).values(directVariable('inverse-a', 'keep')).run();
        entered.resolve();
        await finish.promise;
        order.push('a-commit');
      });
      await entered.promise;
      const second = outer['transaction'](async (nested) => {
        order.push('b-enter');
        await nested
          .insert(sqliteAppVariables)
          .values(directVariable('inverse-b', 'discard'))
          .run();
        order.push('b-rollback');
        throw new Error('rollback sibling B');
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(order).toEqual(['a-enter']);
      finish.resolve();
      await first;
      await expect(second).rejects.toThrow('rollback sibling B');
    });

    expect(order).toEqual(['a-enter', 'a-commit', 'b-enter', 'b-rollback']);
    await expect(
      db.select().from(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'inverse-a')).get()
    ).resolves.toMatchObject({ value_text: 'keep' });
    await expect(
      db.select().from(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'inverse-b')).get()
    ).resolves.toBeUndefined();
  });

  it('coordinates direct builder run/get/all/execute and releases after errors', async () => {
    const db = await memoryDatabase();
    await db.insert(sqliteAppVariables).values(directVariable('builder', 'one')).run();
    await expect(
      db.select().from(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'builder')).get()
    ).resolves.toMatchObject({ value_text: 'one' });
    await expect(db.select().from(sqliteAppVariables).all()).resolves.toHaveLength(1);

    await db
      .update(sqliteAppVariables)
      .set({ value_text: 'two' })
      .where(eq(sqliteAppVariables.key, 'builder'))
      .execute();
    await expect(
      db.select().from(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'builder')).execute()
    ).resolves.toEqual([expect.objectContaining({ value_text: 'two' })]);

    await expect(
      db.insert(sqliteAppVariables).values(directVariable('builder', 'duplicate')).run()
    ).rejects.toThrow();
    await db.delete(sqliteAppVariables).where(eq(sqliteAppVariables.key, 'builder')).run();
    await expect(db.select().from(sqliteAppVariables).all()).resolves.toEqual([]);
  });

  it('rolls back a deferred-foreign-key COMMIT failure before admitting later work', async () => {
    const db = await memoryDatabase();
    await db.run(sql.raw('CREATE TABLE deferred_parent (id INTEGER PRIMARY KEY)'));
    await db.run(
      sql.raw(
        'CREATE TABLE deferred_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, FOREIGN KEY(parent_id) REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)'
      )
    );

    await expect(
      db['transaction'](async (transaction) => {
        await transaction.run(sql.raw('INSERT INTO deferred_child (id, parent_id) VALUES (1, 9)'));
      })
    ).rejects.toThrow();

    // SQLite leaves a deferred-constraint transaction open when COMMIT fails.
    // The coordinator must finish rollback before this base write, then allow
    // both ordinary work and another transaction to proceed.
    await db.run(sql.raw('INSERT INTO deferred_parent (id) VALUES (9)'));
    await db['transaction'](async (transaction) => {
      await transaction.run(sql.raw('INSERT INTO deferred_child (id, parent_id) VALUES (2, 9)'));
    });
    await expect(db.all(sql.raw('SELECT id FROM deferred_child ORDER BY id'))).resolves.toEqual([
      { id: 2 },
    ]);
  });

  dbTest('leaves normal file SQLite on the native transaction path', async ({ db }) => {
    let transactionHandle: unknown;
    await runDatabaseTransaction(db, async (transaction) => {
      transactionHandle = transaction;
      await new AppVariableRepository(transaction).set({
        namespace: 'file',
        key: 'native',
        value: 'committed',
      });
    });
    expect(transactionHandle).not.toBe(db);
    await expect(new AppVariableRepository(db).getPlain('file', 'native')).resolves.toBe(
      'committed'
    );
  });
});
