import { expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { SessionID } from '../../types';
import { dbTest } from '../test-helpers';
import { type SessionPageOptions, SessionRepository } from './sessions';
import {
  exerciseSessionVisibilityParity,
  seedSessionVisibilityFixture,
  sessionVisibilityForm,
} from './sessions.visibility-parity-test-helpers';

dbTest(
  'per-row created_by / session id visibility matches the branch-set form for every principal (SQLite)',
  async ({ db }) => {
    const fixture = await seedSessionVisibilityFixture(db);
    expect(await exerciseSessionVisibilityParity(db, fixture)).toBeGreaterThan(1000);
  },
  120_000
);

dbTest('routes only bounded reads to the per-row probe', async ({ db }) => {
  const fixture = await seedSessionVisibilityFixture(db);
  const me = fixture.users.owner;
  const client = (db as unknown as { $client: { execute: (statement: unknown) => unknown } })
    .$client;
  const execute = vi.spyOn(client, 'execute');
  const ownPage: SessionPageOptions = {
    createdBy: me,
    archived: false,
    sortUpdatedAt: -1,
    includeTotal: false,
    limit: 200,
  };
  const padded = (count: number) => [
    ...fixture.sessionIds,
    ...Array.from({ length: count - fixture.sessionIds.length }, () => generateId() as SessionID),
  ];
  const routes: [string, SessionPageOptions, 'per-row' | 'branch-set'][] = [
    ['gated own page', ownPage, 'per-row'],
    ['oldest first', { ...ownPage, sortUpdatedAt: 1 }, 'per-row'],
    ['archived own page', { ...ownPage, archived: true }, 'per-row'],
    ['with a status', { ...ownPage, status: 'idle' }, 'per-row'],
    ['offset within the cap', { ...ownPage, limit: 100, skip: 100 }, 'per-row'],
    // The ordered scan passes skip + limit of my rows before it can stop.
    ['deep offset', { ...ownPage, skip: 10_000 }, 'branch-set'],
    ['offset past the cap', { ...ownPage, skip: 1 }, 'branch-set'],
    // Unreachable through the service ($skip >= 0), but never a small page here.
    ['negative offset', { ...ownPage, skip: -1000, limit: 1100 }, 'branch-set'],
    ['limit past the cap', { ...ownPage, limit: 201 }, 'branch-set'],
    // Without the archived equality no index yields the order: every own row is probed.
    ['archived unset', { ...ownPage, archived: undefined }, 'branch-set'],
    ['created_at order', { ...ownPage, sortUpdatedAt: undefined, sortCreatedAt: -1 }, 'branch-set'],
    ['default order', { ...ownPage, sortUpdatedAt: undefined }, 'branch-set'],
    ['counted', { ...ownPage, includeTotal: true }, 'branch-set'],
    ['another creator', { ...ownPage, createdBy: fixture.users.outsider }, 'branch-set'],
    ['board scope', { ...ownPage, boardId: fixture.boardIds[0] }, 'branch-set'],
    ['branch scope', { ...ownPage, branchId: fixture.branchIds[0] }, 'branch-set'],
    ['branch list scope', { ...ownPage, branchIds: fixture.branchIds }, 'branch-set'],
    ['id list', { sessionIds: fixture.sessionIds.slice(0, 5), limit: 10 }, 'per-row'],
    [
      'id list at the cap, any order or offset',
      { sessionIds: padded(200), sortCreatedAt: 1, skip: 3, limit: 10 },
      'per-row',
    ],
    ['id list past the cap', { sessionIds: padded(201), limit: 10 }, 'branch-set'],
    ['unfiltered', { limit: 10 }, 'branch-set'],
  ];
  for (const [label, opts, expected] of routes) {
    execute.mockClear();
    await new SessionRepository(db).findPage({ ...opts, visibleToUserId: me });
    const statements = execute.mock.calls
      .map(([statement]) =>
        typeof statement === 'string' ? statement : (statement as { sql: string }).sql
      )
      .filter((statement) => statement.includes('from "sessions"'));
    expect(statements.length, label).toBeGreaterThan(0);
    expect(statements.map(sessionVisibilityForm), label).toEqual(statements.map(() => expected));
  }
});

dbTest('walks the own page in index order instead of sorting every own row', async ({ db }) => {
  const fixture = await seedSessionVisibilityFixture(db);
  const client = (
    db as unknown as {
      $client: {
        execute: (statement: unknown) => Promise<{ rows: { detail: unknown }[] }>;
      };
    }
  ).$client;
  await client.execute('ANALYZE');
  const execute = vi.spyOn(client, 'execute');
  await new SessionRepository(db).findPage({
    createdBy: fixture.users.owner,
    visibleToUserId: fixture.users.owner,
    archived: false,
    sortUpdatedAt: -1,
    includeTotal: false,
    limit: 20,
  });
  const statement = execute.mock.calls
    .map(([value]) => value as { sql: string; args: unknown[] })
    .find((value) => typeof value === 'object' && value.sql.includes('from "sessions"'));
  execute.mockRestore();
  expect(sessionVisibilityForm(statement!.sql)).toBe('per-row');
  const plan = await client.execute({
    sql: `EXPLAIN QUERY PLAN ${statement!.sql}`,
    args: statement!.args,
  });
  const details = plan.rows.map((row) => String(row.detail));
  // Rows arrive in updated_at order, so LIMIT stops the scan (and its probes);
  // only equal timestamps are sorted by the session_id tie-breaker.
  expect(details).toContain(
    'SEARCH sessions USING INDEX sessions_archived_updated_idx (archived=?)'
  );
  expect(details).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  expect(details.some((detail) => detail.startsWith('CORRELATED'))).toBe(true);
});
