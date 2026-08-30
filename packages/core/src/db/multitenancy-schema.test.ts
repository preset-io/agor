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
  const migration = [
    readRepoFile('packages/core/drizzle/postgres/0067_drop_serialized_sessions.sql'),
    readRepoFile('packages/core/drizzle/postgres/0099_shared_session_prompting.sql'),
  ].join('\n');
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
  const githubInstallStateMigration = readRepoFile(
    'packages/core/drizzle/postgres/0082_github_install_state.sql'
  );
  const discordGatewayHybridMigration = readRepoFile(
    'packages/core/drizzle/postgres/0094_discord_gateway_hybrid.sql'
  );
  const externalIdentitiesMigration = readRepoFile(
    'packages/core/drizzle/postgres/0090_external_user_identities.sql'
  );
  const codexDeviceAuthMigration = readRepoFile(
    'packages/core/drizzle/postgres/0091_codex_device_auth_attempts.sql'
  );
  const capabilityPoliciesMigration = readRepoFile(
    'packages/core/drizzle/postgres/0095_board_branch_capability_policies.sql'
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
        ...githubInstallStateMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...discordGatewayHybridMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...externalIdentitiesMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...codexDeviceAuthMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...capabilityPoliciesMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
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
    readRepoFile('packages/core/drizzle/postgres/0082_github_install_state.sql'),
    readRepoFile('packages/core/drizzle/postgres/0094_discord_gateway_hybrid.sql'),
    readRepoFile('packages/core/drizzle/postgres/0090_external_user_identities.sql'),
    readRepoFile('packages/core/drizzle/postgres/0091_codex_device_auth_attempts.sql'),
    readRepoFile('packages/core/drizzle/postgres/0095_board_branch_capability_policies.sql'),
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

  it('limits GitHub install callback discovery and cleanup to explicit capabilities', () => {
    const migration = readRepoFile('packages/core/drizzle/postgres/0082_github_install_state.sql');

    expect(migration).toContain('FOR SELECT');
    expect(migration).toContain("= 'github_install_state_callback'");
    expect(migration).toContain("= 'github_install_state_maintenance'");
    expect(migration).toContain('"expires_at" <= CURRENT_TIMESTAMP');
    expect(migration).not.toMatch(
      /CREATE POLICY "github_install_state_(?:callback_discovery|maintenance)"[\s\S]*WITH CHECK/
    );
  });

  it('limits Codex device attempt maintenance to due rows and its explicit capability', () => {
    const migration = readRepoFile(
      'packages/core/drizzle/postgres/0091_codex_device_auth_attempts.sql'
    );
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("COALESCE(current_setting('agor.system_scope', true), '') = ''");
    expect(migration).toContain("= 'codex_device_auth_maintenance'");
    expect(migration).toContain('"poll_lease_expires_at"');
    expect(migration).toContain('"exchange_started_at"');
    expect(migration).toContain('"finished_at"');
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

  it('keeps GitHub install state authority out of Redis', () => {
    const sources = [
      readRepoFile('packages/core/src/db/repositories/github-install-states.ts'),
      readRepoFile('apps/agor-daemon/src/services/github-install-state.ts'),
    ].join('\n');

    expect(sources).not.toMatch(/from\s+['"][^'"]*redis/i);
    expect(sources).not.toMatch(/ioredis|redlock|publish\(|subscribe\(/i);
  });
});
