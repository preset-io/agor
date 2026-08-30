import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import { pendingOfflineCutoverMigrations, preflightSQLiteCapabilityPolicyOwners } from './migrate';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/** Both journals, Postgres first, as the migrator reads them off disk. */
const readJournals = () =>
  Promise.all(
    [
      new URL('../../drizzle/postgres/meta/_journal.json', import.meta.url),
      new URL('../../drizzle/sqlite/meta/_journal.json', import.meta.url),
    ].map(async (url) => JSON.parse(await readFile(url, 'utf8')) as { entries: JournalEntry[] })
  );

describe('Postgres migrations', () => {
  it('starts the Discord hybrid migration with its transaction-local lock timeout', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0094_discord_gateway_hybrid.sql', import.meta.url),
      'utf8'
    );
    const statements = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '3s';");
    expect(
      statements.filter((statement) => /^ALTER TABLE /i.test(statement)).length
    ).toBeGreaterThan(0);
    expect(migration.match(/SET LOCAL lock_timeout = '3s'/g)).toHaveLength(1);
  });

  it('treats the board/branch RBAC replacement as an offline incompatible cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0094_discord_gateway_hybrid'],
        pending: ['0095_board_branch_capability_policies'],
      })
    ).toEqual(['0095_board_branch_capability_policies']);
    expect(
      pendingOfflineCutoverMigrations('sqlite', {
        applied: ['0097_discord_gateway_hybrid'],
        pending: ['0098_board_branch_capability_policies'],
      })
    ).toEqual(['0098_board_branch_capability_policies']);
  });

  it('requires the Knowledge claim protocol migration to be an offline existing-db cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0073_task_runtime_reconciliation'],
        pending: ['0074_knowledge_embedding_claims'],
      })
    ).toEqual(['0074_knowledge_embedding_claims']);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0074_knowledge_embedding_claims'],
      })
    ).toEqual([]);
  });

  it('enforces the structurally incompatible MCP OAuth migration as an offline cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0076_executor_session_token_session_binding'],
        pending: ['0078_mcp_oauth_pending_flows'],
      })
    ).toEqual(['0078_mcp_oauth_pending_flows']);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0078_mcp_oauth_pending_flows'],
      })
    ).toEqual([]);
  });

  it('enforces the GitHub callback authority migration as an offline cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0078_mcp_oauth_pending_flows'],
        pending: ['0082_github_install_state'],
      })
    ).toEqual(['0082_github_install_state']);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0082_github_install_state'],
      })
    ).toEqual([]);
  });

  it('enforces PostgreSQL transcript indexes as an offline existing-db cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0082_github_install_state'],
        pending: ['0083_transcript_hydration_keysets'],
      })
    ).toEqual(['0083_transcript_hydration_keysets']);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0085_github_install_state'],
        pending: ['0086_transcript_hydration_keysets'],
      })
    ).toEqual([]);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0083_transcript_hydration_keysets'],
      })
    ).toEqual([]);
  });

  it('enforces credential-generation token claims as an offline existing-db cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0091_codex_device_auth_attempts'],
        pending: ['0092_add_user_credential_generation'],
      })
    ).toEqual(['0092_add_user_credential_generation']);
    expect(
      pendingOfflineCutoverMigrations('sqlite', {
        applied: ['0094_codex_device_auth_attempts'],
        pending: ['0095_add_user_credential_generation'],
      })
    ).toEqual([]);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_cuddly_captain_america', '0092_add_user_credential_generation'],
      })
    ).toEqual([]);
  });

  it('assigns GitHub install state unique post-HA migration watermarks', async () => {
    const [postgresJournal, sqliteJournal] = await readJournals();

    for (const [journal, expectedTag, expectedIndex, hydrationTag, hydrationIndex] of [
      [postgresJournal, '0082_github_install_state', 82, '0083_transcript_hydration_keysets', 83],
      [sqliteJournal, '0085_github_install_state', 85, '0086_transcript_hydration_keysets', 86],
    ] as const) {
      const entry = journal.entries.find(({ tag }) => tag === expectedTag);
      const predecessor = journal.entries.find(({ idx }) => idx === expectedIndex - 1);
      expect(entry).toMatchObject({ idx: expectedIndex, tag: expectedTag });
      expect(entry?.when).toBeGreaterThan(predecessor?.when ?? 0);

      // Find by tag rather than assuming it is the newest entry — later
      // migrations (e.g. add_user_filesystem_home) legitimately follow it.
      const hydrationEntry = journal.entries.find(({ tag }) => tag === hydrationTag);
      expect(hydrationEntry).toMatchObject({ idx: hydrationIndex, tag: hydrationTag });
      expect(hydrationEntry?.when).toBeGreaterThan(entry?.when ?? 0);
    }
  });

  it('gives the newest migration a unique watermark that sorts it last', async () => {
    // Drizzle applies pending migrations in `when` order, so a new migration
    // that does not sort after the one before it can run out of order against a
    // database that has neither.
    //
    // Only the newest pair is checked. Early history predates the convention
    // and is not monotonic — those migrations have all long since applied
    // everywhere, and rewriting their watermarks now would change hashes that
    // deployed databases already record. What must hold is that each new
    // migration extends the sequence.
    //
    // Deliberately not pinned to a tag: naming the newest migration makes every
    // migration an edit to this test, and that edit is the moment the property
    // stops being checked.
    for (const { entries } of await readJournals()) {
      expect(entries.length).toBeGreaterThan(1);

      // `idx` is not dense — the history has a gap where a generated migration
      // was dropped before it shipped — but both keys still have to identify an
      // entry, or the journal no longer describes the directory beside it.
      expect(new Set(entries.map((entry) => entry.tag)).size).toBe(entries.length);
      expect(new Set(entries.map((entry) => entry.idx)).size).toBe(entries.length);

      const newest = entries.at(-1);
      const highestWhenBefore = Math.max(...entries.slice(0, -1).map((entry) => entry.when));
      const highestIdxBefore = Math.max(...entries.slice(0, -1).map((entry) => entry.idx));

      expect(
        newest?.when,
        `${newest?.tag} does not sort after every earlier migration`
      ).toBeGreaterThan(highestWhenBefore);
      expect(newest?.idx).toBeGreaterThan(highestIdxBefore);
    }
  });

  it('keeps Knowledge pgvector storage out of required base migrations', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0043_kb_embeddings.sql', import.meta.url),
      'utf8'
    );

    expect(migration).not.toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector/i);
    expect(migration).not.toContain('kb_unit_embeddings');
    expect(migration).not.toMatch(/\bembedding\s+vector\b/i);
    expect(migration).toContain('kb_embedding_spaces');
  });

  it('stores executor connection timestamps as UTC-safe instants', async () => {
    const [connectionMigration, heartbeatMigration] = await Promise.all([
      readFile(
        new URL('../../drizzle/postgres/0064_task_dispatching.sql', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../../drizzle/postgres/0065_executor_heartbeat_timezone.sql', import.meta.url),
        'utf8'
      ),
    ]);

    expect(connectionMigration).toMatch(
      /ADD COLUMN "executor_connected_at" timestamp with time zone/i
    );
    expect(heartbeatMigration).toMatch(
      /ALTER COLUMN "last_executor_heartbeat_at" TYPE timestamp with time zone/i
    );
    expect(heartbeatMigration).toMatch(/AT TIME ZONE 'UTC'/i);
  });

  it('persists only an executor bearer fingerprint behind forced tenant RLS', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0075_executor_session_token_authority.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"token_fingerprint" varchar(64) PRIMARY KEY NOT NULL');
    expect(migration).not.toMatch(/"(?:raw_)?token"\s/);
    expect(migration).toContain(
      'ALTER TABLE "executor_session_token_authorities" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain('"tenant_id" = COALESCE');
  });

  it('stores MCP OAuth pending flow capabilities without raw codes or tokens', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0078_mcp_oauth_pending_flows.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"state_hash" varchar(64) NOT NULL');
    expect(migration).toContain('"sealed_material" text');
    expect(migration).not.toMatch(/"(?:raw_)?state"\s/);
    expect(migration).not.toMatch(/"(?:authorization_)?code"\s/);
    expect(migration).not.toMatch(/"(?:access|refresh|bearer)_token"\s/);
    expect(migration).toContain('ALTER TABLE "mcp_oauth_pending_flows" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("SET LOCAL lock_timeout = '3s'");
    expect(migration).toContain("COALESCE(current_setting('agor.system_scope', true), '') = ''");
    expect(migration).toContain("= 'mcp_oauth_callback'");
    expect(migration).toContain('"state_hash" = current_setting(\'agor.oauth_state_hash\', true)');
    expect(migration).toContain("= 'mcp_oauth_maintenance'");
    expect(migration).toContain('DELETE FROM "user_mcp_oauth_tokens"');
    expect(migration).toContain('"grant_binding_fingerprint" varchar(64)');
    expect(migration).toContain('"refresh_generation" bigint');
    expect(migration).toContain('"refresh_success_generation" bigint');
    expect(migration).toContain('"oauth_metadata_uri" text');
    expect(migration).toContain('"user_mcp_oauth_tokens_tenant_user_fk"');
    expect(migration).toContain('"user_mcp_oauth_tokens_tenant_server_fk"');
    expect(migration).toContain('"mcp_oauth_pending_flows_current_user_grant_uq"');
    expect(migration).toContain('"mcp_oauth_pending_flows_current_shared_grant_uq"');
    expect(migration).not.toMatch(/CHECK\s*\([^)]*"status"/i);
    expect(migration).not.toMatch(/CHECK\s*\([^)]*"oauth_mode"/i);
  });

  it('persists only a GitHub install state hash behind forced tenant RLS', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0082_github_install_state.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"state_hash" varchar(64) PRIMARY KEY NOT NULL');
    expect(migration).toContain('"tenant_id" text');
    expect(migration).toContain('"user_id" varchar(36) NOT NULL');
    expect(migration).toContain('"intent" text NOT NULL');
    expect(migration).toContain('ALTER TABLE "github_install_states" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain(
      "\"tenant_id\" = NULLIF(current_setting('agor.tenant_id', true), '')"
    );
    expect(migration).not.toContain("COALESCE(NULLIF(current_setting('agor.tenant_id'");
    expect(migration).not.toContain('"tenant_id" text DEFAULT');
    expect(migration).toContain(
      'CREATE INDEX "github_install_states_expires_idx"\n\tON "github_install_states" ("expires_at")'
    );
    expect(migration).not.toMatch(/["`]state["`]\s/);
    expect(migration).not.toContain('raw_state');
  });
});

describe('Board and branch capability-policy migration', () => {
  const createLegacyTables = async (client: ReturnType<typeof createClient>) => {
    await client.executeMultiple(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (user_id text PRIMARY KEY NOT NULL);
      CREATE TABLE groups (group_id text PRIMARY KEY NOT NULL);
      CREATE TABLE boards (
        board_id text PRIMARY KEY NOT NULL, created_at integer NOT NULL, updated_at integer,
        created_by text NOT NULL, data text NOT NULL
      );
      CREATE TABLE branches (
        branch_id text PRIMARY KEY NOT NULL, board_id text, created_at integer NOT NULL,
        updated_at integer, created_by text NOT NULL, permission_source text NOT NULL,
        others_can text, others_fs_access text, data text NOT NULL
      );
      CREATE TABLE board_owners (
        board_id text NOT NULL, user_id text NOT NULL, created_at integer,
        PRIMARY KEY (board_id,user_id)
      );
      CREATE TABLE branch_owners (
        branch_id text NOT NULL, user_id text NOT NULL, created_at integer,
        PRIMARY KEY (branch_id,user_id)
      );
      CREATE TABLE board_group_grants (
        board_id text NOT NULL, group_id text NOT NULL, can text NOT NULL,
        fs_access text, created_at integer NOT NULL, updated_at integer,
        PRIMARY KEY (board_id,group_id)
      );
      CREATE TABLE branch_group_grants (
        branch_id text NOT NULL, group_id text NOT NULL, can text NOT NULL,
        fs_access text, created_at integer NOT NULL, updated_at integer,
        PRIMARY KEY (branch_id,group_id)
      );
    `);
  };

  it('backfills equal-or-less access, attributes owners, and retires legacy authority in SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-rbac-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });
    try {
      await createLegacyTables(client);
      await client.executeMultiple(`
        INSERT INTO users VALUES ('owner'),('manager'),('member');
        INSERT INTO groups VALUES ('design');
        INSERT INTO boards VALUES (
          'board-1',1,2,'owner',
          '{"access_mode":"shared","default_others_can":"prompt","default_others_fs_access":"write","default_dangerously_allow_session_sharing":true}'
        );
        INSERT INTO board_owners VALUES ('board-1','owner',1),('board-1','manager',2);
        INSERT INTO board_group_grants VALUES ('board-1','design','all','write',1,2);
        INSERT INTO branches VALUES (
          'branch-1','board-1',1,2,'deleted-creator','override','prompt','write',
          '{"dangerously_allow_session_sharing":true}'
        );
        INSERT INTO branch_owners VALUES ('branch-1','owner',1),('branch-1','manager',2);
        INSERT INTO branch_group_grants VALUES ('branch-1','design','prompt','write',1,2);
        INSERT INTO branches VALUES (
          'branch-2','board-1',1,2,'member','board','none','none','{}'
        );
        INSERT INTO branch_owners VALUES ('branch-2','member',1),('branch-2','manager',2);
        INSERT INTO branch_group_grants VALUES ('branch-2','design','prompt','read',1,2);
        INSERT INTO branches VALUES (
          'branch-3','board-1',1,2,'owner','board','none','none','{}'
        );
        INSERT INTO branch_owners VALUES ('branch-3','owner',1);
      `);
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0098_board_branch_capability_policies.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const owners = await client.execute(
        `SELECT 'board:'||board_id AS resource,primary_owner_user_id FROM boards
         UNION ALL SELECT 'branch:'||branch_id,primary_owner_user_id FROM branches`
      );
      expect(
        Object.fromEntries(owners.rows.map((row) => [row.resource, row.primary_owner_user_id]))
      ).toEqual({
        'board:board-1': 'owner',
        'branch:branch-1': 'owner',
        'branch:branch-2': 'member',
        'branch:branch-3': 'owner',
      });

      const boardGroup = await client.execute(
        `SELECT role FROM board_access_entries WHERE board_id='board-1' AND group_id='design'`
      );
      expect(boardGroup.rows[0]).toMatchObject({ role: 'manager' });

      const template = await client.execute(
        `SELECT sharing_mode,others_role,others_fs_access
         FROM branch_permission_configs WHERE board_id='board-1'`
      );
      expect(template.rows[0]).toMatchObject({
        sharing_mode: 'shared',
        others_role: 'collaborator',
        others_fs_access: 'write',
      });

      const migratedGroup = await client.execute(
        `SELECT role,fs_access FROM branch_permission_entries
         WHERE group_id='design' AND config_id IN (
           SELECT config_id FROM branch_permission_configs WHERE branch_id='branch-1'
         )`
      );
      expect(migratedGroup.rows[0]).toMatchObject({ role: 'collaborator', fs_access: 'write' });
      const bindings = await client.execute(
        `SELECT branch_id,permission_binding FROM branches WHERE branch_id IN ('branch-2','branch-3') ORDER BY branch_id`
      );
      expect(bindings.rows).toEqual([
        { branch_id: 'branch-2', permission_binding: 'override' },
        { branch_id: 'branch-3', permission_binding: 'inherit' },
      ]);
      const inheritedMaterialization = await client.execute(
        `SELECT role,fs_access,user_id,group_id FROM branch_permission_entries
         WHERE config_id IN (SELECT config_id FROM branch_permission_configs WHERE branch_id='branch-2')
         ORDER BY COALESCE(user_id,group_id)`
      );
      expect(inheritedMaterialization.rows).toEqual([
        { role: 'manager', fs_access: 'write', user_id: null, group_id: 'design' },
        { role: 'manager', fs_access: 'write', user_id: 'manager', group_id: null },
        { role: 'manager', fs_access: 'write', user_id: 'owner', group_id: null },
      ]);
      const untouchedInheritedConfig = await client.execute(
        `SELECT count(*) AS count FROM branch_permission_configs WHERE branch_id='branch-3'`
      );
      expect(Number(untouchedInheritedConfig.rows[0]?.count)).toBe(0);
      const branchEntryColumns = await client.execute(
        "SELECT name FROM pragma_table_info('branch_permission_entries')"
      );
      expect(branchEntryColumns.rows.map((row) => row.name)).toContain('role');
      expect(branchEntryColumns.rows.map((row) => row.name)).not.toContain('capabilities');
      const configColumns = await client.execute(
        "SELECT name FROM pragma_table_info('branch_permission_configs')"
      );
      expect(configColumns.rows.map((row) => row.name)).toContain('others_role');
      expect(configColumns.rows.map((row) => row.name)).not.toContain('others_capabilities');
      const boardEntryColumns = await client.execute(
        "SELECT name FROM pragma_table_info('board_access_entries')"
      );
      expect(boardEntryColumns.rows.map((row) => row.name)).toContain('role');
      expect(boardEntryColumns.rows.map((row) => row.name)).not.toContain('capabilities');
      const boardPolicyColumns = await client.execute(
        "SELECT name FROM pragma_table_info('board_access_policies')"
      );
      expect(boardPolicyColumns.rows.map((row) => row.name)).toContain('others_role');
      expect(boardPolicyColumns.rows.map((row) => row.name)).not.toContain('others_capabilities');
      await expect(
        client.execute("UPDATE branch_permission_entries SET role='editor' WHERE group_id='design'")
      ).rejects.toThrow(/CHECK constraint failed/);
      await expect(
        client.execute("UPDATE board_access_entries SET role='collaborator'")
      ).rejects.toThrow(/CHECK constraint failed/);
      const migratedSchema = await client.execute(
        `SELECT sql FROM sqlite_master
         WHERE type='table' AND name IN (
           'branches','board_access_policies','board_access_entries','branch_permission_configs',
           'branch_permission_entries','branch_session_sharing_grants'
         )`
      );
      const migratedSchemaSql = migratedSchema.rows.map((row) => String(row.sql)).join('\n');
      for (const constraintName of [
        'branches_permission_binding_check',
        'board_access_policies_sharing_mode_check',
        'board_access_policies_others_role_check',
        'board_access_entries_role_check',
        'board_access_entries_principal_check',
        'branch_permission_configs_sharing_mode_check',
        'branch_permission_configs_others_role_check',
        'branch_permission_configs_others_fs_access_check',
        'branch_permission_configs_target_check',
        'branch_permission_entries_role_check',
        'branch_permission_entries_fs_access_check',
        'branch_permission_entries_principal_check',
        'branch_session_sharing_grants_principal_check',
      ]) {
        expect(migratedSchemaSql).toMatch(
          new RegExp(`CONSTRAINT ["\x60]?${constraintName}["\x60]? CHECK`)
        );
      }
      await expect(
        client.execute(
          `INSERT INTO boards
           (board_id,created_at,created_by,data,primary_owner_user_id)
           VALUES ('orphan-board',3,'missing','{}','missing')`
        )
      ).rejects.toThrow(/board primary owner does not exist/i);
      await expect(
        client.execute(
          `INSERT INTO branches
           (branch_id,created_at,created_by,permission_source,data,primary_owner_user_id,permission_binding)
           VALUES ('orphan-branch',3,'missing','override','{}','missing','override')`
        )
      ).rejects.toThrow(/branch primary owner does not exist/i);
      const sharing = await client.execute(
        'SELECT count(*) AS count FROM branch_session_sharing_rules'
      );
      expect(Number(sharing.rows[0]?.count)).toBe(0);

      for (const table of [
        'board_owners',
        'branch_owners',
        'board_group_grants',
        'branch_group_grants',
      ]) {
        const rows = await client.execute(`SELECT count(*) AS count FROM ${table}`);
        expect(Number(rows.rows[0]?.count)).toBe(0);
      }
      const retired = await client.execute(
        `SELECT others_can,others_fs_access,json_extract(data,'$.dangerously_allow_session_sharing') AS sharing
         FROM branches WHERE branch_id='branch-1'`
      );
      expect(retired.rows[0]).toEqual({
        others_can: 'none',
        others_fs_access: 'none',
        sharing: 0,
      });
      const legacyBoardCompatibility = await client.execute(
        `SELECT json_extract(data,'$.access_mode') AS access_mode,
                json_extract(data,'$.default_others_can') AS others_can,
                json_extract(data,'$.default_others_fs_access') AS fs_access,
                json_extract(data,'$.default_dangerously_allow_session_sharing') AS sharing
         FROM boards WHERE board_id='board-1'`
      );
      expect(legacyBoardCompatibility.rows[0]).toEqual({
        access_mode: 'private',
        others_can: 'none',
        fs_access: 'none',
        sharing: 0,
      });
      await expect(
        client.execute(
          `UPDATE branches SET primary_owner_user_id='manager' WHERE branch_id='branch-1'`
        )
      ).rejects.toThrow(/primary owner is immutable/);
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps private board fallbacks closed and prefers current owners in SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-rbac-private-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });
    try {
      await createLegacyTables(client);
      await client.executeMultiple(`
        INSERT INTO users VALUES ('owner'),('manager'),('removed-creator'),('unmatched');
        INSERT INTO groups VALUES ('design');
        INSERT INTO boards VALUES (
          'private-board',1,2,'removed-creator',
          '{"access_mode":"private","default_others_can":"session","default_others_fs_access":"write"}'
        ),(
          'creator-only-private',1,2,'removed-creator',
          '{"access_mode":"private","default_others_can":"none","default_others_fs_access":"none"}'
        );
        INSERT INTO board_owners VALUES
          ('private-board','owner',1),('private-board','manager',2),
          ('creator-only-private','owner',1);
        INSERT INTO board_group_grants VALUES
          ('private-board','design','all','write',1,2);
        INSERT INTO branches VALUES
          ('inherited','private-board',1,2,'owner','board','session','write','{}'),
          ('removed-creator',NULL,1,2,'removed-creator','override','none','none','{}'),
          ('nullable-owner-order',NULL,1,2,'removed-creator','override','none','none','{}');
        INSERT INTO branch_owners VALUES
          ('inherited','owner',1),
          ('removed-creator','manager',3),
          ('nullable-owner-order','manager',NULL),
          ('nullable-owner-order','owner',5);
      `);
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0098_board_branch_capability_policies.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const owners = await client.execute(
        `SELECT 'board:'||board_id AS resource,primary_owner_user_id FROM boards
         UNION ALL SELECT 'branch:'||branch_id,primary_owner_user_id FROM branches`
      );
      expect(
        Object.fromEntries(owners.rows.map((row) => [row.resource, row.primary_owner_user_id]))
      ).toMatchObject({
        'board:private-board': 'owner',
        'board:creator-only-private': 'owner',
        'branch:inherited': 'owner',
        'branch:removed-creator': 'manager',
        'branch:nullable-owner-order': 'owner',
      });

      const template = await client.execute(
        `SELECT sharing_mode,others_role,others_fs_access
         FROM branch_permission_configs WHERE board_id='private-board'`
      );
      // Named current owners require a shared package, but private-board
      // defaults must never turn into an unmatched-member fallback.
      expect(template.rows[0]).toMatchObject({
        sharing_mode: 'shared',
        others_role: 'none',
        others_fs_access: 'none',
      });
      const binding = await client.execute(
        `SELECT permission_binding FROM branches WHERE branch_id='inherited'`
      );
      expect(binding.rows[0]).toMatchObject({ permission_binding: 'inherit' });
      const ignoredGroup = await client.execute(
        `SELECT count(*) AS count FROM branch_permission_entries e
         JOIN branch_permission_configs c ON c.config_id=e.config_id
         WHERE c.board_id='private-board' AND e.group_id='design'`
      );
      expect(Number(ignoredGroup.rows[0]?.count)).toBe(0);
      const creatorGrant = await client.execute(
        `SELECT role FROM board_access_entries
         WHERE board_id='private-board' AND user_id='removed-creator'`
      );
      expect(creatorGrant.rows[0]).toEqual({ role: 'manager' });
      const creatorOnlyPolicy = await client.execute(
        `SELECT p.sharing_mode,p.others_role,e.role
         FROM board_access_policies p
         JOIN board_access_entries e ON e.board_id=p.board_id AND e.user_id='removed-creator'
         WHERE p.board_id='creator-only-private'`
      );
      expect(creatorOnlyPolicy.rows[0]).toEqual({
        sharing_mode: 'shared',
        others_role: 'none',
        role: 'manager',
      });
      const unmatchedLegacyVisibility = await client.execute(
        `SELECT count(*) AS count FROM boards
         WHERE created_by='unmatched'
            OR COALESCE(json_extract(data,'$.access_mode'),'shared')='shared'
            OR EXISTS (
              SELECT 1 FROM board_owners
              WHERE board_owners.board_id=boards.board_id AND board_owners.user_id='unmatched'
            )
            OR EXISTS (
              SELECT 1 FROM branches
              WHERE branches.board_id=boards.board_id
                AND branches.permission_source='override'
                AND branches.others_can<>'none'
            )`
      );
      expect(Number(unmatchedLegacyVisibility.rows[0]?.count)).toBe(0);

      await expect(
        client.execute(
          `UPDATE branches SET permission_binding='corrupt' WHERE branch_id='inherited'`
        )
      ).rejects.toThrow(/CHECK constraint failed/);
      await expect(
        client.execute(
          `UPDATE branch_permission_configs SET others_fs_access='execute' WHERE board_id='private-board'`
        )
      ).rejects.toThrow(/CHECK constraint failed/);
      await expect(client.execute(`DELETE FROM users WHERE user_id='owner'`)).rejects.toThrow(
        /owns protected boards or branches/
      );
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when SQLite cannot attribute a primary owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-rbac-owner-preflight-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });
    try {
      await createLegacyTables(client);
      await client.execute(
        `INSERT INTO branches VALUES ('orphan',NULL,1,1,'missing','override','none','none','{}')`
      );
      const db = createDatabase({ url: `file:${join(directory, 'migration.db')}` });
      await expect(preflightSQLiteCapabilityPolicyOwners(db)).rejects.toThrow(/branch:orphan/);
      await (db as unknown as { $client: { close(): Promise<void> } }).$client.close();
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0098_board_branch_capability_policies.sql', import.meta.url),
        'utf8'
      );
      let failed = false;
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (!statement.trim()) continue;
        try {
          await client.execute(statement);
        } catch (error) {
          failed = true;
          expect(String(error)).toMatch(/constraint/i);
          break;
        }
      }
      expect(failed).toBe(true);
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forces tenant RLS and reports unattributed object IDs in PostgreSQL', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0095_board_branch_capability_policies.sql', import.meta.url),
      'utf8'
    );
    for (const table of [
      'board_access_policies',
      'board_access_entries',
      'branch_permission_configs',
      'branch_permission_entries',
      'branch_session_sharing_rules',
      'branch_session_sharing_grants',
    ]) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`tenant_isolation_${table}`);
    }
    expect(migration).toContain("string_agg(kind||':'||id");
    expect(migration).toContain('RBAC migration cannot attribute primary owners');
    expect(migration).toContain("SET LOCAL lock_timeout = '3s'");
    expect(migration).toContain('ORDER BY bo.created_at NULLS LAST,bo.user_id');
    expect(migration).toContain('CONSTRAINT "boards_tenant_primary_owner_fk"');
    expect(migration).toContain('CONSTRAINT "branches_tenant_primary_owner_fk"');
    expect(migration).toContain("CHECK (\"permission_binding\" IN ('inherit','override'))");
    expect(migration).toContain("CHECK (\"sharing_mode\" IN ('private','shared'))");
    expect(migration).toContain("CHECK (\"others_fs_access\" IN ('none','read','write'))");
    expect(migration).toContain("CHECK (\"fs_access\" IN ('none','read','write'))");
    expect(migration).toContain('"access_mode":"private"');
    expect(migration).toContain('"default_others_can":"none"');
    expect(migration).toContain('"others_role" text');
    expect(migration).toContain('"role" text');
    expect(migration).not.toContain('"capabilities" jsonb');
    expect(migration).not.toContain('"others_capabilities"');
    expect(migration).toContain(
      'FOREIGN KEY ("tenant_id","board_id") REFERENCES "board_access_policies"("tenant_id","board_id")'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("tenant_id","config_id") REFERENCES "branch_permission_configs"("tenant_id","config_id")'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("tenant_id","config_id","session_owner_user_id") REFERENCES "branch_session_sharing_rules"("tenant_id","config_id","session_owner_user_id")'
    );
  });

  it('replaces personal grants with closed shared-session switches in SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-session-sharing-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });
    try {
      await client.executeMultiple(`
        CREATE TABLE branch_permission_configs (config_id text PRIMARY KEY NOT NULL);
        CREATE TABLE branch_session_sharing_rules (
          config_id text NOT NULL, session_owner_user_id text NOT NULL,
          PRIMARY KEY (config_id,session_owner_user_id)
        );
        CREATE TABLE branch_session_sharing_grants (grant_id text PRIMARY KEY NOT NULL);
        CREATE TABLE app_variables (namespace text NOT NULL, key text NOT NULL);
        CREATE TABLE branches (branch_id text PRIMARY KEY NOT NULL, data text NOT NULL);
        CREATE TABLE boards (board_id text PRIMARY KEY NOT NULL, data text NOT NULL);
        INSERT INTO branch_permission_configs VALUES ('config-1');
        INSERT INTO branch_session_sharing_rules VALUES ('config-1','owner-1');
        INSERT INTO branch_session_sharing_grants VALUES ('grant-1');
        INSERT INTO app_variables VALUES ('workspace_preferences','personal_session_sharing_enabled');
        INSERT INTO branches VALUES ('branch-1','{"dangerously_allow_session_sharing":true,"keep":1}');
        INSERT INTO boards VALUES ('board-1','{"default_dangerously_allow_session_sharing":true,"keep":1}');
      `);
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0102_shared_session_prompting.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const config = await client.execute(
        'SELECT allow_shared_session_prompts FROM branch_permission_configs'
      );
      expect(config.rows).toEqual([{ allow_shared_session_prompts: 0 }]);
      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'branch_session_sharing_%'"
      );
      expect(tables.rows).toEqual([]);
      const preference = await client.execute('SELECT count(*) AS count FROM app_variables');
      expect(Number(preference.rows[0]?.count)).toBe(0);
      const legacyJson = await client.execute(`
        SELECT json_extract(data,'$.dangerously_allow_session_sharing') AS branch_sharing,
               json_extract((SELECT data FROM boards WHERE board_id='board-1'),
                            '$.default_dangerously_allow_session_sharing') AS board_sharing,
               json_extract(data,'$.keep') AS kept
        FROM branches WHERE branch_id='branch-1'
      `);
      expect(legacyJson.rows[0]).toEqual({ branch_sharing: null, board_sharing: null, kept: 1 });
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('Executor session token authority migrations', () => {
  it('keeps the SQLite schema compatible without enabling shared authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-token-authority-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0078_executor_session_token_authority.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(executor_session_token_authorities)');
      const columnNames = columns.rows.map((column) => column.name);

      expect(columnNames).toContain('token_fingerprint');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('token');
      expect(columnNames).not.toContain('raw_token');
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('MCP OAuth pending-flow migrations', () => {
  it('keeps SQLite schema-compatible while standalone flow authority stays local', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-mcp-oauth-flow-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0081_mcp_oauth_pending_flows.sql', import.meta.url),
        'utf8'
      );
      await client.execute('PRAGMA foreign_keys = OFF');
      await client.execute(`
        CREATE TABLE user_mcp_oauth_tokens (
          user_id text,
          mcp_server_id text NOT NULL,
          oauth_access_token text NOT NULL,
          oauth_token_expires_at integer,
          oauth_refresh_token text,
          oauth_client_id text,
          oauth_client_secret text,
          created_at integer NOT NULL,
          updated_at integer
        )
      `);
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(mcp_oauth_pending_flows)');
      const columnNames = columns.rows.map((column) => column.name);
      expect(columnNames).toContain('state_hash');
      expect(columnNames).toContain('sealed_material');
      expect(columnNames).toContain('grant_generation');
      expect(columnNames).toContain('config_fingerprint');
      expect(columnNames).toContain('is_current');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('state');
      expect(columnNames).not.toContain('code');
      expect(columnNames).not.toContain('access_token');
      expect(columnNames).not.toContain('refresh_token');

      const tokenColumns = await client.execute('PRAGMA table_info(user_mcp_oauth_tokens)');
      const tokenColumnNames = tokenColumns.rows.map((column) => column.name);
      expect(tokenColumnNames).toContain('grant_binding_fingerprint');
      expect(tokenColumnNames).toContain('oauth_metadata_uri');
      expect(tokenColumnNames).toContain('refresh_generation');
      expect(tokenColumnNames).toContain('refresh_success_generation');

      const tableSql = await client.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mcp_oauth_pending_flows'"
      );
      expect(String(tableSql.rows[0]?.sql)).not.toMatch(/CHECK\s*\(/i);
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('GitHub install state migrations', () => {
  it('keeps standalone SQLite schema-compatible without a raw state column', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-github-state-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0085_github_install_state.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(github_install_states)');
      const columnNames = columns.rows.map((column) => column.name);
      expect(columnNames).toContain('state_hash');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('state');
      expect(columnNames).not.toContain('raw_state');
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('SDK session storage retirement migrations', () => {
  it('discards SQLite snapshot payloads while preserving task data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-session-storage-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      await client.execute(`
        CREATE TABLE tasks (
          task_id text PRIMARY KEY NOT NULL,
          session_md5 text,
          data text NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE serialized_sessions (
          id text PRIMARY KEY NOT NULL,
          payload blob
        )
      `);
      await client.execute(
        `INSERT INTO tasks (task_id, session_md5, data)
         VALUES ('task-1', 'legacy-hash', '{"preserved":true}')`
      );
      await client.execute(
        `INSERT INTO serialized_sessions (id, payload)
         VALUES ('snapshot-1', X'1F8B0800')`
      );

      const migration = await readFile(
        new URL('../../drizzle/sqlite/0072_drop_serialized_sessions.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const legacyTable = await client.execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'serialized_sessions'`
      );
      const taskColumns = await client.execute('PRAGMA table_info(tasks)');
      const task = await client.execute('SELECT task_id, data FROM tasks');

      expect(legacyTable.rows).toHaveLength(0);
      expect(taskColumns.rows.map((column) => column.name)).not.toContain('session_md5');
      expect(task.rows).toEqual([{ task_id: 'task-1', data: '{"preserved":true}' }]);
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('explicitly drops the legacy table and task hash column in Postgres', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0067_drop_serialized_sessions.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('DROP TABLE "serialized_sessions"');
    expect(migration).toContain('ALTER TABLE "tasks" DROP COLUMN "session_md5"');
    expect(migration).toContain('payloads are intentionally discarded');
  });
});

describe('Session recent index migrations', () => {
  it('keeps the PostgreSQL ordering index tenant-aware and bounds lock acquisition', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0088_session_recent_index.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain("SET LOCAL lock_timeout = '3s'");
    expect(migration).toContain(
      '"sessions_tenant_archived_updated_idx" ON "sessions" ("tenant_id","archived","updated_at")'
    );
    expect(migration.trim().endsWith('SET LOCAL lock_timeout = DEFAULT;')).toBe(true);
    expect(migration).not.toContain('"board_id"');
  });

  it('applies the equivalent standalone SQLite ordering index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-session-recent-index-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      await client.execute(`
        CREATE TABLE sessions (
          session_id text PRIMARY KEY NOT NULL,
          archived integer NOT NULL,
          updated_at integer
        )
      `);
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0091_session_recent_index.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA index_info(sessions_archived_updated_idx)');
      expect(columns.rows.map((column) => column.name)).toEqual(['archived', 'updated_at']);
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('MCP catalog install identity migration', () => {
  it('consolidates ownerless SQLite duplicates, preserves overlapping attachments, and enforces identity', async () => {
    const client = createClient({ url: ':memory:' });
    await client.executeMultiple(`
      CREATE TABLE mcp_servers (mcp_server_id text PRIMARY KEY, created_at integer NOT NULL, updated_at integer, name text NOT NULL, transport text NOT NULL, scope text NOT NULL, enabled integer NOT NULL, owner_user_id text, source text NOT NULL, data text NOT NULL);
      CREATE TABLE session_mcp_servers (session_id text NOT NULL, mcp_server_id text NOT NULL, enabled integer NOT NULL, added_at integer NOT NULL, PRIMARY KEY(session_id,mcp_server_id));
      INSERT INTO mcp_servers VALUES ('old',1,NULL,'x','http','session',1,NULL,'catalog','{"catalog_entry_name":"com.example/x"}');
      INSERT INTO mcp_servers VALUES ('new',2,NULL,'x','http','session',1,NULL,'catalog','{"catalog_entry_name":"com.example/x"}');
      INSERT INTO session_mcp_servers VALUES ('both','old',1,1),('both','new',1,2),('old-only','old',1,1);
    `);
    const migration = await readFile(
      new URL('../../drizzle/sqlite/0092_mcp_catalog_install_identity.sql', import.meta.url),
      'utf8'
    );
    await client.executeMultiple(migration.replaceAll('--> statement-breakpoint', ''));
    const rows = await client.execute(
      'SELECT mcp_server_id FROM mcp_servers ORDER BY mcp_server_id'
    );
    expect(rows.rows.map((row) => row.mcp_server_id)).toEqual(['new']);
    const attachments = await client.execute(
      'SELECT session_id,mcp_server_id FROM session_mcp_servers ORDER BY session_id'
    );
    expect(attachments.rows).toEqual([
      { session_id: 'both', mcp_server_id: 'new' },
      { session_id: 'old-only', mcp_server_id: 'new' },
    ]);
    await expect(
      client.execute({
        sql: `INSERT INTO mcp_servers (mcp_server_id,created_at,name,transport,scope,enabled,owner_user_id,source,catalog_entry_name,data) VALUES ('duplicate',3,'x','http','session',1,NULL,'catalog','com.example/x','{}')`,
      })
    ).rejects.toThrow(/UNIQUE/);
    await client.close();
  });

  it('uses null-safe owner identity in both dialects', async () => {
    const [sqlite, postgres] = await Promise.all([
      readFile(
        new URL('../../drizzle/sqlite/0092_mcp_catalog_install_identity.sql', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../../drizzle/postgres/0089_mcp_catalog_install_identity.sql', import.meta.url),
        'utf8'
      ),
    ]);
    expect(sqlite).toContain('owner_user_id` IS loser.`owner_user_id');
    expect(sqlite).toContain("coalesce(`owner_user_id`,'')");
    expect(postgres).toContain('coalesce("owner_user_id",\'\')');
  });
});

describe('MCP stdio transport repair migrations', () => {
  it('removes only remote fields from SQLite stdio rows', async () => {
    const client = createClient({ url: ':memory:' });
    await client.executeMultiple(`
      CREATE TABLE mcp_servers (
        mcp_server_id text PRIMARY KEY,
        transport text NOT NULL,
        tenant_id text NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE user_mcp_oauth_tokens (
        user_id text,
        mcp_server_id text NOT NULL,
        oauth_access_token text NOT NULL
      );
      CREATE TABLE mcp_oauth_pending_flows (
        attempt_id text PRIMARY KEY,
        mcp_server_id text NOT NULL,
        sealed_material text
      );
      INSERT INTO mcp_servers VALUES (
        'legacy-stdio',
        'stdio',
        'tenant-a',
        '{"command":"mcp-server-shortcut","args":[""],"env":{"SHORTCUT_API_TOKEN":"{{ user.env.SHORTCUT_API_TOKEN }}"},"auth":{"type":"bearer","token":"obsolete"},"url":"https://unused.example","headers":{"X-Unused":"obsolete"},"config_version":7}'
      );
      INSERT INTO mcp_servers VALUES (
        'clean-stdio',
        'stdio',
        'tenant-b',
        '{"command":"other-server","env":{"TOKEN":"{{ user.env.OTHER_TOKEN }}"}}'
      );
      INSERT INTO mcp_servers VALUES (
        'remote',
        'http',
        'tenant-a',
        '{"url":"https://mcp.example.com","headers":{"X-Key":"kept"},"auth":{"type":"bearer","token":"kept"}}'
      );
      INSERT INTO user_mcp_oauth_tokens VALUES
        ('user-a', 'legacy-stdio', 'obsolete-legacy-grant'),
        ('user-b', 'clean-stdio', 'obsolete-clean-grant'),
        ('user-a', 'remote', 'kept-remote-grant');
      INSERT INTO mcp_oauth_pending_flows VALUES
        ('legacy-flow', 'legacy-stdio', 'obsolete-legacy-sealed-material'),
        ('clean-flow', 'clean-stdio', 'obsolete-clean-sealed-material'),
        ('remote-flow', 'remote', 'kept-remote-sealed-material');
    `);

    const migration = await readFile(
      new URL('../../drizzle/sqlite/0099_strip_stdio_remote_fields.sql', import.meta.url),
      'utf8'
    );
    await client.executeMultiple(migration.replaceAll('--> statement-breakpoint', ''));

    const rows = await client.execute(
      'SELECT mcp_server_id, tenant_id, data FROM mcp_servers ORDER BY mcp_server_id'
    );
    const decoded = Object.fromEntries(
      rows.rows.map((row) => [row.mcp_server_id, JSON.parse(row.data as string)])
    );
    expect(decoded['legacy-stdio']).toEqual({
      command: 'mcp-server-shortcut',
      args: [''],
      env: { SHORTCUT_API_TOKEN: '{{ user.env.SHORTCUT_API_TOKEN }}' },
      config_version: 7,
    });
    expect(decoded['clean-stdio']).toEqual({
      command: 'other-server',
      env: { TOKEN: '{{ user.env.OTHER_TOKEN }}' },
    });
    expect(decoded.remote).toEqual({
      url: 'https://mcp.example.com',
      headers: { 'X-Key': 'kept' },
      auth: { type: 'bearer', token: 'kept' },
    });
    expect(rows.rows.map((row) => [row.mcp_server_id, row.tenant_id])).toEqual([
      ['clean-stdio', 'tenant-b'],
      ['legacy-stdio', 'tenant-a'],
      ['remote', 'tenant-a'],
    ]);
    const grants = await client.execute(
      'SELECT mcp_server_id FROM user_mcp_oauth_tokens ORDER BY mcp_server_id'
    );
    expect(grants.rows.map((row) => row.mcp_server_id)).toEqual(['remote']);
    const pendingFlows = await client.execute(
      'SELECT mcp_server_id, sealed_material FROM mcp_oauth_pending_flows ORDER BY mcp_server_id'
    );
    expect(pendingFlows.rows).toEqual([
      {
        mcp_server_id: 'remote',
        sealed_material: 'kept-remote-sealed-material',
      },
    ]);
    client.close();
  });

  it('bounds the PostgreSQL cross-tenant repair to a temporary exact capability', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0096_strip_stdio_remote_fields.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain(`SET "data" = server."data" - 'auth' - 'url' - 'headers'`);
    expect(migration).toContain(`WHERE "transport" = 'stdio'`);
    expect(migration).toContain('DELETE FROM "user_mcp_oauth_tokens"');
    expect(migration).toContain('DELETE FROM "mcp_oauth_pending_flows"');
    expect(migration).toContain("= 'stdio_remote_repair_0096'");
    expect(migration.match(/CREATE POLICY "stdio_repair_0096_/g)).toHaveLength(6);
    expect(migration.match(/DROP POLICY "stdio_repair_0096_/g)).toHaveLength(6);
    expect(migration).toContain("SELECT set_config('agor.system_scope', '', true)");
  });
});
