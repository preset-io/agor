import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { generateId } from '../lib/ids';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { BoardRepository } from './repositories/boards';
import { BranchRepository } from './repositories/branches';
import { RepoRepository } from './repositories/repos';
import { SessionRepository } from './repositories/sessions';
import { UsersRepository } from './repositories/users';
import { getCurrentTenantId } from './tenant-scope';

export const SESSION_RECENCY_MIGRATION = '0113_session_recency_not_null';

export async function beforeSessionRecencyMigrations(dialect: 'sqlite' | 'postgres') {
  const folder = await mkdtemp(join(tmpdir(), 'agor-session-recency-'));
  await cp(new URL(`../../drizzle/${dialect}/`, import.meta.url), folder, { recursive: true });
  const path = join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(path, 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const next = journal.entries.find(({ tag }) => tag === SESSION_RECENCY_MIGRATION)!;
  journal.entries = journal.entries.filter(({ idx }) => idx < next.idx);
  await writeFile(path, JSON.stringify(journal));
  return folder;
}

export async function stageFailingSessionRecencyMigration(
  folder: string,
  dialect: 'sqlite' | 'postgres'
) {
  const source = new URL(`../../drizzle/${dialect}/`, import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.slice(
    0,
    journal.entries.findIndex(({ tag }) => tag === SESSION_RECENCY_MIGRATION) + 1
  );
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  await writeFile(
    join(folder, `${SESSION_RECENCY_MIGRATION}.sql`),
    (await readFile(new URL(`${SESSION_RECENCY_MIGRATION}.sql`, source), 'utf8')) +
      '\n--> statement-breakpoint\nSELECT agor_recency_test_failure();\n'
  );
}

/** Seed the actual prior schema, including a nullable historical row and children. */
export async function seedHistoricalSessionRecency(db: Database) {
  const owner = await new UsersRepository(db).create({ email: `${generateId()}@example.invalid` });
  const board = await new BoardRepository(db).create({
    name: 'Recency',
    created_by: owner.user_id,
    access_mode: 'private',
  });
  const repo = await new RepoRepository(db).create({
    slug: `recency-${generateId()}`,
    name: 'Recency',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/recency.git',
    local_path: '/tmp/recency',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    board_id: board.board_id,
    created_by: owner.user_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: 1,
    path: '/tmp/recency',
  });
  const sessions = new SessionRepository(db);
  const parent = await sessions.create({
    branch_id: branch.branch_id,
    created_by: owner.user_id,
    created_at: '2025-01-01T00:00:00.000Z',
    title: 'Preserved parent',
    custom_context: { preserved: true },
  });
  const child = await sessions.create({
    branch_id: branch.branch_id,
    created_by: owner.user_id,
    created_at: '2025-02-01T00:00:00.000Z',
    last_updated: '2025-03-01T00:00:00.000Z',
    genealogy: {
      parent_session_id: parent.session_id,
      forked_from_session_id: parent.session_id,
      children: [],
    },
  });
  // This fixture deliberately stops before the restriction schema exists. Use
  // historical SQL rather than current repository admission, which must keep
  // checking tenant_restrictions for production prompt creation.
  const task = { task_id: generateId() };
  const taskData = JSON.stringify({
    full_prompt: 'Preserved child task',
    message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
    git_state: { ref_at_start: 'unknown', sha_at_start: 'unknown' },
  });
  if (isPostgresDatabase(db)) {
    await executeRaw(
      db,
      sql`INSERT INTO tasks (tenant_id, task_id, session_id, created_at, status, created_by, data)
          VALUES (${getCurrentTenantId() ?? 'default'}, ${task.task_id}, ${parent.session_id}, ${new Date().toISOString()}, 'created', ${owner.user_id}, ${taskData}::jsonb)`
    );
  } else {
    await executeRaw(
      db,
      sql`INSERT INTO tasks (task_id, session_id, created_at, status, created_by, data)
          VALUES (${task.task_id}, ${parent.session_id}, ${Date.now()}, 'created', ${owner.user_id}, ${taskData})`
    );
  }
  await executeRaw(
    db,
    sql`UPDATE sessions SET updated_at = NULL WHERE session_id = ${parent.session_id}`
  );
  const rows = rawRows(
    await executeRaw(
      db,
      sql`SELECT * FROM sessions WHERE session_id IN (${parent.session_id}, ${child.session_id}) ORDER BY session_id`
    )
  );
  const taskRows = rawRows(
    await executeRaw(db, sql`SELECT * FROM tasks WHERE task_id = ${task.task_id}`)
  );
  return { parent, child, task, rows, taskRows };
}
