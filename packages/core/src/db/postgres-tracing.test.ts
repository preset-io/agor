import { describe, expect, it } from 'vitest';
import {
  type DatadogTracer,
  instrumentDrizzlePostgresForTracing,
  resolvePostgresTracer,
} from './postgres-tracing';

interface TracedCall {
  name: string;
  resource?: string;
  type?: string;
  tags?: Record<string, unknown>;
}

/** Records trace() calls and runs the wrapped fn like dd-trace would. */
class RecordingTracer implements DatadogTracer {
  readonly calls: TracedCall[] = [];
  trace<T>(
    name: string,
    options: { resource?: string; type?: string; tags?: Record<string, unknown> },
    fn: () => T
  ): T {
    this.calls.push({ name, resource: options.resource, type: options.type, tags: options.tags });
    return fn();
  }
}

/** A fake prepared query whose run-methods resolve to a marker. */
function fakePrepared(marker: string) {
  return {
    executed: [] as string[],
    async execute() {
      this.executed.push('execute');
      return `${marker}:execute`;
    },
    async all() {
      this.executed.push('all');
      return `${marker}:all`;
    },
    async values() {
      this.executed.push('values');
      return `${marker}:values`;
    },
  };
}

/**
 * Fresh Drizzle-like environment per test. `prepareQuery` lives on the
 * PROTOTYPE — mirroring Drizzle's PgSession — so patching the prototype must
 * also cover a second session instance (a transaction sub-session shares the
 * prototype). A NEW class per call keeps the global prototype patch isolated
 * between tests.
 */
function newDb() {
  class FakePgSession {
    prepareQuery(query: { sql: string }) {
      return fakePrepared(query.sql);
    }
  }
  return { db: { session: new FakePgSession() }, Session: FakePgSession };
}

describe('instrumentDrizzlePostgresForTracing', () => {
  it('wraps execute/all/values in a postgres.query span with the SQL as resource', async () => {
    const tracer = new RecordingTracer();
    const { db } = newDb();
    expect(instrumentDrizzlePostgresForTracing(db, { tracer })).toBe(true);

    const prepared = db.session.prepareQuery({ sql: 'select * from sessions where id = $1' }) as {
      execute(): Promise<string>;
    };
    const result = await prepared.execute();

    expect(result).toBe('select * from sessions where id = $1:execute'); // original still runs
    expect(tracer.calls).toEqual([
      {
        name: 'postgres.query',
        resource: 'select * from sessions where id = $1',
        type: 'sql',
        tags: { 'db.system': 'postgresql', 'span.kind': 'client', component: 'postgres.js' },
      },
    ]);
  });

  it('traces all three run-methods', async () => {
    const tracer = new RecordingTracer();
    const { db } = newDb();
    instrumentDrizzlePostgresForTracing(db, { tracer });
    const p = db.session.prepareQuery({ sql: 'select 1' }) as {
      execute(): Promise<string>;
      all(): Promise<string>;
      values(): Promise<string>;
    };
    await p.execute();
    await p.all();
    await p.values();
    expect(tracer.calls.map((c) => c.name)).toEqual([
      'postgres.query',
      'postgres.query',
      'postgres.query',
    ]);
  });

  it('covers a second session sharing the prototype (transaction sub-session)', async () => {
    const tracer = new RecordingTracer();
    const { db, Session } = newDb();
    instrumentDrizzlePostgresForTracing(db, { tracer });

    // Simulate the tx sub-session: a different instance, same prototype.
    const txSession = new Session();
    const prepared = txSession.prepareQuery({ sql: 'set_config($1,$2,true)' }) as {
      execute(): Promise<string>;
    };
    await prepared.execute();

    expect(tracer.calls).toHaveLength(1);
    expect(tracer.calls[0]?.resource).toBe('set_config($1,$2,true)');
  });

  it('is idempotent — a second install does not double-wrap', async () => {
    const tracer = new RecordingTracer();
    const { db } = newDb();
    expect(instrumentDrizzlePostgresForTracing(db, { tracer })).toBe(true);
    expect(instrumentDrizzlePostgresForTracing(db, { tracer })).toBe(true);
    const p = db.session.prepareQuery({ sql: 'select 1' }) as { execute(): Promise<string> };
    await p.execute();
    expect(tracer.calls).toHaveLength(1); // exactly one span, not two
  });

  it('propagates errors while still opening the span', async () => {
    const tracer = new RecordingTracer();
    class ThrowingSession {
      prepareQuery(_q: { sql: string }) {
        return {
          async execute() {
            throw new Error('query failed');
          },
        };
      }
    }
    const db = { session: new ThrowingSession() };
    instrumentDrizzlePostgresForTracing(db, { tracer });
    const prepared = db.session.prepareQuery({ sql: 'bad' }) as { execute(): Promise<unknown> };
    await expect(prepared.execute()).rejects.toThrow('query failed');
    expect(tracer.calls).toHaveLength(1);
  });

  it('no-ops without a tracer and never patches', async () => {
    const { db } = newDb();
    expect(instrumentDrizzlePostgresForTracing(db, { tracer: null })).toBe(false);
    const p = db.session.prepareQuery({ sql: 'select 1' }) as { execute(): Promise<string> };
    // Original result unchanged; no throw.
    expect(await p.execute()).toBe('select 1:execute');
  });

  it('returns false (no throw) when the session shape is missing', () => {
    const tracer = new RecordingTracer();
    expect(instrumentDrizzlePostgresForTracing({}, { tracer })).toBe(false);
    expect(instrumentDrizzlePostgresForTracing(null, { tracer })).toBe(false);
    expect(instrumentDrizzlePostgresForTracing({ session: {} }, { tracer })).toBe(false);
  });
});

describe('resolvePostgresTracer', () => {
  const validTracer = { trace: () => undefined };
  const notFound = (id: string) => {
    throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
  };

  it('prefers dd-trace-api, then falls back to dd-trace', () => {
    const seen: string[] = [];
    expect(
      resolvePostgresTracer((id) => {
        seen.push(id);
        if (id === 'dd-trace-api') return validTracer;
        throw new Error('unreached');
      })
    ).toBe(validTracer);
    expect(seen).toEqual(['dd-trace-api']);

    expect(resolvePostgresTracer((id) => (id === 'dd-trace' ? validTracer : notFound(id)))).toBe(
      validTracer
    );
  });

  it('unwraps a default export and returns null when neither resolves', () => {
    expect(
      resolvePostgresTracer((id) =>
        id === 'dd-trace-api' ? { default: validTracer } : notFound(id)
      )
    ).toBe(validTracer);
    expect(resolvePostgresTracer(notFound)).toBeNull();
    expect(resolvePostgresTracer(() => ({}))).toBeNull(); // no callable .trace
  });
});
