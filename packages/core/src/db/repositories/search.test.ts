/**
 * Server search (`searchTokensCondition`) cost and evaluation order, on SQLite:
 * the haystack is built once per row whatever the token count, and only for
 * rows the caller may see, so a hidden row's text never costs time (no
 * timing oracle) and a long query cannot multiply per-row work.
 */
import { expect } from 'vitest';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { SessionRepository } from './sessions';
import { exerciseUserScopeReads } from './user-scope-reads.test-helpers';

type Statement = { sql: string; args: unknown[] };
type Client = {
  execute: (stmt: unknown) => Promise<{ rows: Array<Record<string, unknown>> }>;
};
/** The SQLite client under `db`. */
const clientOf = (db: Database) => (db as unknown as { $client: Client }).$client;

/** Run `read`, returning the statements it sent. */
async function captured(db: Database, read: () => Promise<unknown>): Promise<Statement[]> {
  const client = clientOf(db);
  const execute = client.execute;
  const statements: Statement[] = [];
  client.execute = (stmt) => {
    if (typeof stmt === 'object' && stmt && 'sql' in stmt) statements.push(stmt as Statement);
    return execute.call(client, stmt);
  };
  try {
    await read();
  } finally {
    client.execute = execute;
  }
  return statements;
}

/** How many `json_extract` calls SQLite compiled `statement` into. */
async function jsonExtractCalls(db: Database, statement: Statement): Promise<number> {
  const plan = await clientOf(db).execute({
    sql: `explain ${statement.sql}`,
    args: statement.args,
  });
  return plan.rows.filter((row) => String(row.p4 ?? '').startsWith('json_extract')).length;
}

dbTest('the haystack is built once per row, whatever the token count', async ({ db }) => {
  const fixture = await exerciseUserScopeReads(db);
  const branches = new BranchRepository(db);
  const sessions = new SessionRepository(db);
  const calls = async (read: () => Promise<unknown>) => {
    const statements = await captured(db, read);
    const counts = await Promise.all(statements.map((s) => jsonExtractCalls(db, s)));
    return Math.max(...counts);
  };
  for (const visibleToUserId of [fixture.viewer, undefined]) {
    const branchCalls = (search: string) =>
      calls(() => branches.findPage({ visibleToUserId, search }));
    expect(await branchCalls('a b c d e f g h')).toBe(await branchCalls('a'));
    const sessionCalls = (search: string) =>
      calls(() => sessions.findPage({ visibleToUserId, search, limit: 10 }));
    expect(await sessionCalls('a b c d e f g h')).toBe(await sessionCalls('a'));
  }
});

dbTest("a hidden row's text is never evaluated", async ({ db }) => {
  const fixture = await exerciseUserScopeReads(db);
  // Malformed JSON makes `json_extract` throw: any evaluation of these rows'
  // haystacks fails the read.
  const [, privateId] = fixture.branchIds;
  const [, hiddenSessionId] = fixture.titledSessionIds;
  await clientOf(db).execute({
    sql: 'update branches set data = ? where branch_id = ?',
    args: ['{not json', privateId],
  });
  await clientOf(db).execute({
    sql: 'update sessions set data = ? where session_id = ?',
    args: ['{not json', hiddenSessionId],
  });
  const branches = await new BranchRepository(db).findPage({
    visibleToUserId: fixture.viewer,
    search: 'scope',
  });
  expect(branches.data.map((b) => b.branch_id)).not.toContain(privateId);
  expect(branches.total).toBeGreaterThan(0);
  const sessions = await new SessionRepository(db).findPage({
    visibleToUserId: fixture.viewer,
    search: 'login',
    limit: 10,
  });
  expect(sessions.data.map((s) => s.session_id)).toEqual([fixture.titledSessionIds[0]]);
});

dbTest('repeated tokens match once', async ({ db }) => {
  const fixture = await exerciseUserScopeReads(db);
  const found = await new SessionRepository(db).findPage({
    visibleToUserId: fixture.viewer,
    search: Array.from({ length: 127 }, () => 'login').join(' '),
    limit: 10,
  });
  expect(found.data.map((s) => s.session_id)).toEqual([fixture.titledSessionIds[0]]);
});
