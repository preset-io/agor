import { describe, expect, it } from 'vitest';
import type { DatadogTracer } from '../tracing/datadog';
import { instrumentPostgresTransactions } from './postgres-transaction-tracing';
import { getCurrentTenantId, runWithTenantContext } from './tenant-context';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recordingTracer() {
  const calls: { name: string; tags: Record<string, unknown>; finished: boolean }[] = [];
  const tracer: DatadogTracer = {
    trace(name, options, fn) {
      const call = { name, tags: { ...options.tags }, finished: false };
      calls.push(call);
      const result = fn({
        setTag: (key, value) => {
          call.tags[key] = value;
        },
      });
      void Promise.resolve(result).then(
        () => {
          call.finished = true;
        },
        () => {
          call.finished = true;
        }
      );
      return result;
    },
  };
  return { tracer, calls };
}

describe('PostgreSQL transaction timing', () => {
  it('separates acquisition, callback work and commit without changing the transaction', async () => {
    const acquire = deferred();
    const work = deferred();
    const commit = deferred();
    const entered = deferred();
    const bodyDone = deferred();
    const tx = {};
    const options = { isolationLevel: 'read committed' };
    const { tracer, calls } = recordingTracer();
    let transactions = 0;
    const db = {
      async transaction(callback: (handle: object) => Promise<string>, config: object) {
        expect(this).toBe(db);
        expect(config).toBe(options);
        transactions++;
        await acquire.promise;
        const result = await callback(tx);
        bodyDone.resolve();
        await commit.promise;
        return result;
      },
    };
    instrumentPostgresTransactions(db, tracer, 10);
    instrumentPostgresTransactions(db, tracer, 10);
    const result = db.transaction(async (handle) => {
      expect(handle).toBe(tx);
      entered.resolve();
      await work.promise;
      return 'result';
    }, options);
    expect(calls.map((c) => c.name)).toEqual(['postgres.transaction']);
    expect(calls[0].tags).not.toHaveProperty('db.transaction.acquire_ms');
    acquire.resolve();
    await entered.promise;
    expect(calls[0].tags['db.transaction.acquire_ms']).toBeGreaterThanOrEqual(0);
    expect(calls[0].tags['db.pool.max']).toBe(10);
    expect(calls[1].name).toBe('postgres.transaction.work');
    work.resolve();
    await bodyDone.promise;
    expect(calls[1].finished).toBe(true);
    expect(calls[0].finished).toBe(false);
    commit.resolve();
    await expect(result).resolves.toBe('result');
    expect(calls[0].finished).toBe(true);
    expect(transactions).toBe(1);
  });

  it('preserves concurrent tenant context and rejects a cross-tenant switch', async () => {
    const { tracer } = recordingTracer();
    const db = {
      async transaction(callback: () => Promise<void>) {
        return callback();
      },
    };
    instrumentPostgresTransactions(db, tracer);
    await Promise.all(
      ['tenant-a', 'tenant-b'].map((tenant) =>
        runWithTenantContext(tenant, () =>
          db.transaction(async () => {
            await Promise.resolve();
            expect(getCurrentTenantId()).toBe(tenant);
            const foreign = tenant === 'tenant-a' ? 'tenant-b' : 'tenant-a';
            expect(() => runWithTenantContext(foreign, () => undefined)).toThrow(
              'Cannot enter tenant context'
            );
          })
        )
      )
    );
  });

  it('propagates acquisition, body, and commit errors without retrying', async () => {
    for (const stage of ['acquire', 'body', 'commit']) {
      const failure = new Error(stage);
      let transactions = 0;
      const db = {
        async transaction(callback: () => Promise<void>) {
          transactions++;
          if (stage === 'acquire') throw failure;
          await callback();
          throw failure;
        },
      };
      instrumentPostgresTransactions(db, recordingTracer().tracer);
      await expect(
        db.transaction(async () => {
          if (stage === 'body') throw failure;
        })
      ).rejects.toBe(failure);
      expect(transactions).toBe(1);
    }
  });

  it('leaves frozen handles alone', () => {
    const transaction = () => 'unchanged';
    const db = Object.freeze({ transaction });
    expect(() => instrumentPostgresTransactions(db, recordingTracer().tracer)).not.toThrow();
    expect(db.transaction).toBe(transaction);
  });
});
