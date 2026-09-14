import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPostgresDatabase } from './database-wrapper';
import { type DatadogTracer, instrumentDrizzlePostgresForTracing } from './postgres-tracing';
import * as postgresSchema from './schema.postgres';
import { runWithTenantDatabaseScope } from './tenant-scope';

/**
 * Validates the tracing shim against the REAL drizzle-orm/postgres-js internals
 * (not fakes). This is the regression guard promised in postgres-tracing.ts: if
 * a Drizzle upgrade moves the `PgSession.prepareQuery` chokepoint, `installed`
 * flips to false or the span disappears and this suite fails loudly.
 */
const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url)('postgres-tracing against real Drizzle postgres.js', () => {
  const calls: { resource?: string; tags: Record<string, unknown> }[] = [];
  const tracer: DatadogTracer = {
    trace(_name, opts, fn) {
      const call = { resource: opts.resource, tags: { ...opts.tags } };
      calls.push(call);
      return fn({
        setTag: (key, value) => {
          call.tags[key] = value;
        },
      });
    },
  };

  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof postgresSchema>>;

  beforeAll(() => {
    client = postgres(url as string, { max: 1 });
    db = drizzle(client, { schema: postgresSchema });
  });
  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it('installs against the real PgSession prototype', () => {
    expect(instrumentDrizzlePostgresForTracing(db, { tracer })).toBe(true);
  });

  it('emits a postgres.query span for a real db.execute() without breaking it', async () => {
    calls.length = 0;
    const result = await db.execute(sql`select 42 as answer`);
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    expect(Number((rows[0] as { answer?: unknown })?.answer)).toBe(42);
    expect(calls.some((c) => (c.resource ?? '').includes('select 42'))).toBe(true);
  });

  it('emits a span for a real query-builder select (not just db.execute)', async () => {
    calls.length = 0;
    // A builder query with no app table needed — exercises the query-builder
    // path through `prepareQuery`, so a future Drizzle that reroutes builders
    // away from the chokepoint (while keeping db.execute) is caught here.
    const rows = await db
      .select({ answer: sql<number>`13`.as('answer') })
      .from(sql`(select 1) as t`);
    expect(Number((rows[0] as { answer?: unknown })?.answer)).toBe(13);
    expect(calls.some((c) => (c.resource ?? '').includes('13'))).toBe(true);
  });

  it('records queued acquisition on a one-connection pool and preserves tenant boundaries', async () => {
    calls.length = 0;
    const tenantA = '11111111-1111-4111-8111-111111111111';
    const tenantB = '22222222-2222-4222-8222-222222222222';
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = runWithTenantDatabaseScope(db, tenantA, async () => {
      entered();
      await held;
    });
    await ready;
    const second = runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      if (!isPostgresDatabase(scoped)) throw new Error('PostgreSQL test requires PostgreSQL');
      const rows = await scoped.execute(sql`select current_setting('agor.tenant_id') as tenant`);
      expect((rows as unknown as { tenant: string }[])[0].tenant).toBe(tenantB);
      await expect(
        runWithTenantDatabaseScope(db, tenantA, async () => undefined)
      ).rejects.toThrow();
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const transactions = calls.filter((call) => call.resource === 'postgres.transaction');
      expect(transactions).toHaveLength(2);
      expect(transactions[0].tags['db.transaction.acquire_ms']).toBeGreaterThanOrEqual(0);
      expect(transactions[1].tags).not.toHaveProperty('db.transaction.acquire_ms');
      expect(calls.filter((call) => call.resource === 'postgres.transaction.work')).toHaveLength(1);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(calls.filter((call) => call.resource === 'postgres.transaction.work')).toHaveLength(2);
    expect(
      calls.filter((call) => call.resource === 'postgres.transaction')[1].tags[
        'db.transaction.acquire_ms'
      ]
    ).toBeGreaterThanOrEqual(0);
  });
});
