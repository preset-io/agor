import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function postgresSchemaTenantTables(): string[] {
  const source = readRepoFile('packages/core/src/db/schema.postgres.ts');
  const tables = new Set<string>();
  const pgTableRegex = /pgTable\(\s*['"]([^'"]+)['"]\s*,\s*\{([\s\S]*?)\n\s*\}(?:,|\))/g;
  for (const match of source.matchAll(pgTableRegex)) {
    const [, tableName, columnsBlock] = match;
    if (columnsBlock.includes("tenant_id: text('tenant_id')")) tables.add(tableName);
  }
  return [...tables].sort();
}

function retiredTenantTables(): Set<string> {
  const migration = readRepoFile(
    'packages/core/drizzle/postgres/0067_drop_serialized_sessions.sql'
  );
  return new Set(
    [...migration.matchAll(/DROP TABLE(?: IF EXISTS)? "([^"]+)"/g)].map((match) => match[1])
  );
}

function migrationTenantTables(): string[] {
  const migration = readRepoFile('packages/core/drizzle/postgres/0054_app_level_multitenancy.sql');
  const presetsMigration = readRepoFile(
    'packages/core/drizzle/postgres/0059_agentic_tool_presets.sql'
  );
  const uploadsMigration = readRepoFile('packages/core/drizzle/postgres/0068_uploads.sql');
  const executorTokenMigration = readRepoFile(
    'packages/core/drizzle/postgres/0075_executor_session_token_authority.sql'
  );
  const gatewayHaMigration = readRepoFile(
    'packages/core/drizzle/postgres/0076_gateway_listener_ha.sql'
  );
  const mcpOauthMigration = readRepoFile(
    'packages/core/drizzle/postgres/0078_mcp_oauth_pending_flows.sql'
  );
  const retiredTables = retiredTenantTables();
  return [
    ...new Set(
      [
        ...migration.matchAll(/ALTER TABLE "([^"]+)" ADD COLUMN "tenant_id"/g),
        ...presetsMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...uploadsMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...executorTokenMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...gatewayHaMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...mcpOauthMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
      ]
        .map((m) => m[1])
        .filter((table) => !retiredTables.has(table))
    ),
  ].sort();
}

function rlsPolicyTables(): string[] {
  const migration = [
    readRepoFile('packages/core/drizzle/postgres/0055_app_level_multitenancy_rls.sql'),
    readRepoFile('packages/core/drizzle/postgres/0059_agentic_tool_presets.sql'),
    readRepoFile('packages/core/drizzle/postgres/0068_uploads.sql'),
    readRepoFile('packages/core/drizzle/postgres/0075_executor_session_token_authority.sql'),
    readRepoFile('packages/core/drizzle/postgres/0076_gateway_listener_ha.sql'),
    readRepoFile('packages/core/drizzle/postgres/0078_mcp_oauth_pending_flows.sql'),
  ].join('\n');
  const retiredTables = retiredTenantTables();
  return [
    ...new Set(
      [...migration.matchAll(/CREATE POLICY "tenant_isolation_([^"]+)" ON "([^"]+)"/g)]
        .map((m) => m[2])
        .filter((table) => !retiredTables.has(table))
    ),
  ].sort();
}

describe('Postgres multitenancy schema coverage', () => {
  it('keeps active tenant columns, tenant migrations, and RLS policies in sync', () => {
    const schemaTables = postgresSchemaTenantTables();
    const migrationTables = migrationTenantTables();
    const rlsTables = rlsPolicyTables();

    expect(schemaTables).toEqual(migrationTables);
    expect(rlsTables).toEqual(migrationTables);
  });

  it('keeps sqlite schema tenant-column free', () => {
    const sqliteSchema = readRepoFile('packages/core/src/db/schema.sqlite.ts');
    expect(sqliteSchema).not.toContain('tenant_id');
    expect(sqliteSchema).not.toContain("tenant_id'");
  });

  it('limits cross-tenant gateway discovery to enabled rows and an explicit capability', () => {
    const migration = readRepoFile(
      'packages/core/drizzle/postgres/0066_gateway_listener_discovery.sql'
    );

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('"enabled" = true');
    expect(migration).toContain("current_setting('agor.system_scope', true)");
    expect(migration).toContain("= 'gateway_listener_discovery'");
    expect(migration).not.toContain('WITH CHECK');
  });

  it('limits environment health discovery to active non-archived routing rows', () => {
    const migration = readRepoFile('packages/core/drizzle/postgres/0077_environment_health_ha.sql');
    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('"archived" = false');
    expect(migration).toContain("IN ('starting', 'running')");
    expect(migration).toContain("= 'environment_health_discovery'");
    expect(migration).not.toContain('WITH CHECK');
  });

  it('limits upload maintenance discovery to expired rows and an explicit capability', () => {
    const migration = readRepoFile('packages/core/drizzle/postgres/0069_upload_maintenance.sql');

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('"expires_at" IS NOT NULL');
    expect(migration).toContain('"expires_at" < CURRENT_TIMESTAMP');
    expect(migration).toContain("= 'upload_maintenance'");
    expect(migration).not.toContain('WITH CHECK');
  });

  it('limits scheduler discovery to enabled rows and an explicit capability', () => {
    const migration = readRepoFile('packages/core/drizzle/postgres/0071_scheduler_ha_indexes.sql');

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('"enabled" = true');
    expect(migration).toContain('"scheduler_init_completed_at" IS NULL');
    expect(migration).toContain('"scheduled_from_branch" = true');
    expect(migration).toContain("current_setting('agor.system_scope', true)");
    expect(migration).toContain("= 'scheduler_discovery'");
    expect(migration).not.toContain('WITH CHECK');
  });

  it('limits task queue discovery to durable queued rows and an explicit capability', () => {
    const migration = readRepoFile('packages/core/drizzle/postgres/0072_task_queue_ha.sql');

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('"status" = \'queued\'');
    expect(migration).toContain("current_setting('agor.system_scope', true)");
    expect(migration).toContain("= 'task_queue_discovery'");
    expect(migration).not.toContain('WITH CHECK');
  });

  it('limits task-runtime discovery to active routing rows and an explicit capability', () => {
    const migration = readRepoFile(
      'packages/core/drizzle/postgres/0073_task_runtime_reconciliation.sql'
    );

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('"status" IN');
    expect(migration).toContain("'dispatching'");
    expect(migration).toContain("'running'");
    expect(migration).toContain("'stopping'");
    expect(migration).toContain("current_setting('agor.system_scope', true)");
    expect(migration).toContain("= 'task_runtime_discovery'");
    expect(migration).not.toContain('WITH CHECK');
  });

  it('limits Knowledge embedding discovery to routing-only candidate rows', () => {
    const migration = readRepoFile(
      'packages/core/drizzle/postgres/0074_knowledge_embedding_claims.sql'
    );

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('"content_text" IS NOT NULL');
    expect(migration).toContain('"embedding_status" IN');
    expect(migration).toContain("= 'knowledge_embedding_discovery'");
    const runtimeDiscoveryPolicy = migration.slice(
      migration.indexOf('CREATE POLICY "knowledge_embedding_discovery"')
    );
    expect(runtimeDiscoveryPolicy).not.toContain('WITH CHECK');
    expect(migration).toContain("= 'knowledge_embedding_migration_0074'");
    expect(migration).toContain('WITH CHECK');
    expect(migration.match(/DROP POLICY "knowledge_embedding_migration_0074_/g)).toHaveLength(4);
    expect(migration).toContain("SET LOCAL lock_timeout = '3s'");
    expect(migration.trim().endsWith('SET LOCAL lock_timeout = DEFAULT;')).toBe(true);
  });

  it('limits executor token maintenance to retained tombstones and an explicit capability', () => {
    const migration = readRepoFile(
      'packages/core/drizzle/postgres/0075_executor_session_token_authority.sql'
    );

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('"expires_at" < CURRENT_TIMESTAMP');
    expect(migration).toContain('"revoked_at" < CURRENT_TIMESTAMP');
    expect(migration).toContain("= 'executor_token_maintenance'");
    expect(migration).not.toMatch(
      /CREATE POLICY "executor_session_token_maintenance"[\s\S]*WITH CHECK/
    );
  });

  it('binds OAuth callback RLS to one exact fingerprint and narrows maintenance to due rows', () => {
    const migration = readRepoFile(
      'packages/core/drizzle/postgres/0078_mcp_oauth_pending_flows.sql'
    );

    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("COALESCE(current_setting('agor.system_scope', true), '') = ''");
    expect(migration).toContain("= 'mcp_oauth_callback'");
    expect(migration).toContain('"state_hash" = current_setting(\'agor.oauth_state_hash\', true)');
    expect(migration).toContain("= 'mcp_oauth_maintenance'");
    expect(migration).toContain('"expires_at" <= CURRENT_TIMESTAMP');
    expect(migration).toContain(
      '"exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL \'2 minutes\''
    );
    expect(migration).toContain('"finished_at" <= CURRENT_TIMESTAMP - INTERVAL \'24 hours\'');
  });

  it('repairs scheduler occurrence and MCP idempotency indexes as tenant-aware uniques', () => {
    const migration = readRepoFile('packages/core/drizzle/postgres/0071_scheduler_ha_indexes.sql');

    expect(migration).toContain('ON "sessions" ("tenant_id", "schedule_id", "scheduled_run_at")');
    expect(migration).toContain(
      'ON "session_mcp_servers" ("tenant_id", "session_id", "mcp_server_id")'
    );
    expect(migration).toContain('bool_or("enabled")');
    expect(migration.match(/CREATE UNIQUE INDEX/g)).toHaveLength(2);
  });

  it('keeps durable gateway listener authority independent of Redis', () => {
    const sources = [
      readRepoFile('packages/core/src/db/repositories/gateway-channels.ts'),
      readRepoFile('packages/core/src/db/repositories/gateway-inbound-events.ts'),
      readRepoFile('apps/agor-daemon/src/services/gateway.ts'),
    ].join('\n');

    expect(sources).not.toMatch(/from\s+['"][^'"]*redis/i);
    expect(sources).not.toMatch(/ioredis|redlock/i);
  });

  it('keeps OAuth capabilities and token material out of Redis paths', () => {
    const sources = [
      readRepoFile('packages/core/src/db/repositories/mcp-oauth-pending-flows.ts'),
      readRepoFile('apps/agor-daemon/src/services/mcp-oauth-pending-flow-authority.ts'),
      readRepoFile('apps/agor-daemon/src/oauth-cache.ts'),
    ].join('\n');

    expect(sources).not.toMatch(/from\s+['"][^'"]*redis/i);
    expect(sources).not.toMatch(/ioredis|redlock|redisClient|redis\.set/i);
  });

  it('opens the shared MCP catalog for reads but confines writes to an explicit capability', () => {
    const migration = readRepoFile('packages/core/drizzle/postgres/0079_mcp_catalog_entries.sql');

    // No tenant column, therefore no tenant isolation policy to write.
    expect(migration).not.toContain('"tenant_id"');
    expect(migration).not.toMatch(/CREATE POLICY "tenant_isolation_/);

    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toMatch(
      /CREATE POLICY "mcp_catalog_public_read"[\s\S]*?FOR SELECT[\s\S]*?USING \(true\)/
    );
    // The write policy must gate both directions: USING alone would let a
    // tenant-scoped path insert rows it could not then see.
    expect(migration).toMatch(
      /CREATE POLICY "mcp_catalog_ingestion_write"[\s\S]*?USING \(current_setting\('agor\.system_scope', true\) = 'mcp_catalog_ingestion'\)[\s\S]*?WITH CHECK \(current_setting\('agor\.system_scope', true\) = 'mcp_catalog_ingestion'\)/
    );
  });

  it('limits runtime recovery discovery to active resources and an explicit capability', () => {
    const migration = readRepoFile('packages/core/drizzle/postgres/0082_task_runtime_recovery.sql');

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('ON "tasks"');
    expect(migration).toContain('ON "sessions"');
    expect(migration).toContain("'stopping'");
    expect(migration).toContain("= 'task_runtime_recovery'");
    expect(migration).not.toContain('WITH CHECK');
  });
  it('limits terminal consequence recovery to incomplete work and an explicit capability', () => {
    const migration = readRepoFile(
      'packages/core/drizzle/postgres/0083_terminal_consequence_recovery.sql'
    );
    const sqliteMigration = readRepoFile(
      'packages/core/drizzle/sqlite/0085_terminal_consequence_recovery.sql'
    );

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain('ON "tasks"');
    expect(migration).toContain('ON "sessions"');
    expect(migration).toContain("'stopping'");
    expect(migration).toContain("= 'task_runtime_recovery'");
    expect(migration).toContain("terminal_consequences_completed_at' IS NULL");
    expect(migration).toContain("gateway_terminal_delivery' ->> 'status' = 'pending'");
    const sessionPolicy = migration.split('session_runtime_recovery_discovery')[1] ?? '';
    expect(sessionPolicy).not.toContain("'timed_out'");
    expect(migration).not.toContain("INTERVAL '7 days'");
    expect(migration).toContain("set_config('agor.migration_scope'");
    expect(migration).toContain('terminal_consequence_baseline_select');
    expect(migration).toContain('terminal_consequence_baseline_update');
    expect(migration).toContain('DROP POLICY "terminal_consequence_baseline_update"');
    const recoveryPolicies = migration.split('task_runtime_recovery_discovery')[1] ?? '';
    expect(recoveryPolicies).not.toContain('WITH CHECK');
    expect(migration).toContain('Baseline them once');
    expect(sqliteMigration).toContain('terminal_consequences_completed_at');
  });

});
