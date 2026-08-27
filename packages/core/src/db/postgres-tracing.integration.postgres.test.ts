import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DatadogTracer, instrumentDrizzlePostgresForTracing } from './postgres-tracing';
import * as postgresSchema from './schema.postgres';

/**
 * Validates the tracing shim against the REAL drizzle-orm/postgres-js internals
 * (not fakes). This is the regression guard promised in postgres-tracing.ts: if
 * a Drizzle upgrade moves the `PgSession.prepareQuery` chokepoint, `installed`
 * flips to false or the span disappears and this suite fails loudly.
 */
const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url)('postgres-tracing against real Drizzle postgres.js', () => {
  const calls: { resource?: string }[] = [];
  const tracer: DatadogTracer = {
    trace(_name, opts, fn) {
      calls.push({ resource: opts.resource });
      return fn();
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

  // NOTE: transaction-sub-session coverage (the prototype patch reaching the
  // scoped session drizzle creates for a transactional callback) is proven in
  // the unit suite (postgres-tracing.test.ts). We don't open a real transaction
  // here to avoid the raw-Drizzle-transaction multitenancy boundary check for a
  // test that touches no tenant data.
});
