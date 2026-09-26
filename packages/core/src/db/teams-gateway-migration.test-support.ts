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
import { UsersRepository } from './repositories/users';
import { getCurrentTenantId } from './tenant-context';

export const TEAMS_MIGRATION = '0117_teams_gateway_ha';

/** Current-main prefix at 4e7f9edf; no synthetic pre-upgrade schema. */
export async function beforeTeamsMigrations(dialect: 'sqlite' | 'postgres') {
  const folder = await mkdtemp(join(tmpdir(), 'agor-teams-upgrade-'));
  await cp(new URL(`../../drizzle/${dialect}/`, import.meta.url), folder, { recursive: true });
  const journalPath = join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const next = journal.entries.find(({ tag }) => tag === TEAMS_MIGRATION)!;
  journal.entries = journal.entries.filter(({ idx }) => idx < next.idx);
  const expected = dialect === 'postgres' ? '0116_user_api_key_source' : '0115_user_api_key_source';
  if (journal.entries.at(-1)?.tag !== expected) throw new Error('Unexpected main watermark');
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

/** Prove the disable/config cutover rolls back with the schema on failure. */
export async function stageFailingTeamsMigration(folder: string, dialect: 'sqlite' | 'postgres') {
  const source = new URL(`../../drizzle/${dialect}/`, import.meta.url);
  await writeFile(
    join(folder, 'meta/_journal.json'),
    await readFile(new URL('meta/_journal.json', source))
  );
  await writeFile(
    join(folder, `${TEAMS_MIGRATION}.sql`),
    (await readFile(new URL(`${TEAMS_MIGRATION}.sql`, source), 'utf8')) +
      '\n--> statement-breakpoint\nSELECT agor_teams_test_failure();\n'
  );
}

export async function seedLegacyGateway(db: Database) {
  const owner = await new UsersRepository(db).create({ email: `${generateId()}@example.invalid` });
  const board = await new BoardRepository(db).create({
    name: 'Teams migration',
    created_by: owner.user_id,
    access_mode: 'private',
  });
  const repo = await new RepoRepository(db).create({
    slug: `teams-${generateId()}`,
    name: 'Teams migration',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/teams.git',
    local_path: '/tmp/teams-test',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    board_id: board.board_id,
    created_by: owner.user_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: 1,
    path: '/tmp/teams-test',
  });
  const pg = isPostgresDatabase(db);
  const tenantColumns = pg ? sql`tenant_id,` : sql``;
  const tenantValues = pg ? sql`${getCurrentTenantId()},` : sql``;
  const now = pg ? '2026-09-25T12:00:00Z' : 1790337600000;
  const ids = { teams: generateId(), duplicate: generateId(), slack: generateId() };
  for (const [kind, id] of Object.entries(ids)) {
    const type = kind === 'slack' ? 'slack' : 'teams';
    // Deliberately use the old writer shape, not today's gateway repository.
    await executeRaw(
      db,
      sql`INSERT INTO gateway_channels
      (${tenantColumns}id,created_at,updated_at,created_by,name,channel_type,target_branch_id,
        channel_key,enabled,config,provider_installation_id)
      VALUES (${tenantValues}${id},${now},${now},${owner.user_id},${kind},${type},${branch.branch_id},
        ${id},${pg ? true : 1},'{}','shared-teams-app')`
    );
  }
  return { ...ids, now, branch: branch.branch_id, owner: owner.user_id };
}

export async function insertLegacyInbound(db: Database, channel: string) {
  const pg = isPostgresDatabase(db);
  const id = generateId();
  const now = pg ? '2026-09-25T12:00:00Z' : 1790337600000;
  await executeRaw(
    db,
    sql`INSERT INTO gateway_inbound_events
    (${pg ? sql`tenant_id,` : sql``}id,gateway_channel_id,provider_event_id,thread_id,status,
      processing_token,processing_expires_at,received_at)
    VALUES (${pg ? sql`${getCurrentTenantId()},` : sql``}${id},${channel},${id},'thread','processing','old-token',${now},${now})`
  );
  return rawRows(
    await executeRaw(
      db,
      sql`SELECT next_attempt_at, payload_encrypted FROM gateway_inbound_events WHERE id=${id}`
    )
  )[0];
}
