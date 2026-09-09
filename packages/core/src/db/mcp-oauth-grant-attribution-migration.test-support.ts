import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { MCPServerRepository } from './repositories/mcp-servers';
import { UsersRepository } from './repositories/users';
import { getCurrentTenantId } from './tenant-context';

/** Real current-main journal prefix; deliberately never seed new schema columns. */
export async function beforeAttributionMigrations(dialect: 'sqlite' | 'postgres') {
  const folder = await mkdtemp(join(tmpdir(), 'agor-grant-attribution-migration-'));
  await cp(new URL(`../../drizzle/${dialect}/`, import.meta.url), folder, { recursive: true });
  const journalPath = join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const next = journal.entries.find((entry) => entry.tag === '0105_mcp_oauth_grant_attribution');
  if (!next) throw new Error('Missing attribution migration');
  journal.entries = journal.entries.filter((entry) => entry.idx < next.idx);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

/** Force failure after the destructive statements to prove transactional rollback. */
export async function stageFailingAttributionMigration(
  folder: string,
  dialect: 'sqlite' | 'postgres'
) {
  const source = new URL(`../../drizzle/${dialect}/`, import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries.find(({ tag }) => tag === '0105_mcp_oauth_grant_attribution')!;
  const current = JSON.parse(
    await readFile(join(folder, 'meta/_journal.json'), 'utf8')
  ) as typeof journal;
  current.entries.push(entry);
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(current));
  await writeFile(
    join(folder, `${entry.tag}.sql`),
    (await readFile(new URL(`${entry.tag}.sql`, source), 'utf8')) +
      '\n--> statement-breakpoint\nSELECT agor_attribution_test_failure();\n'
  );
}

export async function seedHistoricalGrants(db: Database) {
  const user = await new UsersRepository(db).create({
    email: `${crypto.randomUUID()}@example.test`,
  });
  const server = await new MCPServerRepository(db).create({
    name: `historical-${crypto.randomUUID()}`,
    transport: 'http',
    url: 'https://provider.example.test/mcp',
    scope: 'global',
    enabled: true,
    source: 'user',
    owner_user_id: user.user_id,
    auth: { type: 'oauth', oauth_mode: 'shared' },
  });
  const postgres = isPostgresDatabase(db);
  const now = postgres ? '2026-09-01T12:00:00Z' : 1788264000000;
  for (const subject of [user.user_id, null]) {
    // Raw SQL intentionally targets the pre-0105 relation. Existing tokens
    // (including ciphertext), binding, claims and timestamps must not change.
    await executeRaw(
      db,
      sql`INSERT INTO user_mcp_oauth_tokens
      (${postgres ? sql`tenant_id,` : sql``} user_id, mcp_server_id, oauth_access_token, oauth_refresh_token,
       oauth_client_id, oauth_client_secret, grant_generation,
       grant_binding_version, grant_binding_fingerprint, oauth_metadata_uri,
       oauth_resource_uri, oauth_issuer, oauth_authorization_endpoint,
       oauth_token_endpoint, oauth_redirect_uri, refresh_status,
       refresh_generation, refresh_success_generation, refresh_claim_id,
       refresh_claimed_at, oauth_token_expires_at, created_at, updated_at)
      VALUES (${postgres ? sql`${getCurrentTenantId()},` : sql``} ${subject}, ${server.mcp_server_id}, 'unchanged-access-envelope',
       'unchanged-refresh-envelope', 'unchanged-client-envelope', 'unchanged-secret-envelope',
       27, 4, ${'a'.repeat(64)}, 'https://provider.example.test/metadata',
       'https://provider.example.test/mcp', 'https://provider.example.test',
       'https://provider.example.test/authorize', 'https://provider.example.test/token',
       'https://agor.example.test/callback', 'refreshing', 3, 2,
       '00000000-0000-7000-8000-000000000001', ${now}, ${now}, ${now}, ${now})`
    );
  }
  const personal = rawRows(
    await executeRaw(
      db,
      sql`SELECT * FROM user_mcp_oauth_tokens
    WHERE user_id = ${user.user_id}`
    )
  )[0];
  return { userId: user.user_id, serverId: server.mcp_server_id, personal };
}
