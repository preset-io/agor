import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeRaw, rawRows } from '../database-wrapper';
import { dbTest } from '../test-helpers';
import { parseDatabaseTimestamp } from './branch-access';

// A host outside UTC is what exposed this: SQLite's CURRENT_TIMESTAMP is UTC
// text without a zone, and reading it as local time aged every executor
// heartbeat by the host's offset.
const originalTz = process.env.TZ;
beforeEach(() => {
  process.env.TZ = 'Europe/London';
});
afterEach(() => {
  process.env.TZ = originalTz;
});

describe('parseDatabaseTimestamp', () => {
  it('reads SQLite CURRENT_TIMESTAMP text as UTC', () => {
    expect(parseDatabaseTimestamp('2026-10-12 08:59:15').toISOString()).toBe(
      '2026-10-12T08:59:15.000Z'
    );
    expect(parseDatabaseTimestamp('2026-10-12 08:59:15.250').toISOString()).toBe(
      '2026-10-12T08:59:15.250Z'
    );
  });

  it('passes Dates and zoned strings through unchanged', () => {
    const at = new Date('2026-10-12T08:59:15.000Z');
    expect(parseDatabaseTimestamp(at)).toBe(at);
    expect(parseDatabaseTimestamp('2026-10-12T08:59:15+01:00').toISOString()).toBe(
      '2026-10-12T07:59:15.000Z'
    );
  });
});

dbTest('SQLite CURRENT_TIMESTAMP parses to the current instant', async ({ db }) => {
  const [row] = rawRows(await executeRaw(db, sql`SELECT CURRENT_TIMESTAMP AS now`));
  const skewMs = Math.abs(parseDatabaseTimestamp(row!.now).getTime() - Date.now());
  expect(skewMs).toBeLessThan(5_000);
});
