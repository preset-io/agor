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
  const retiredTables = retiredTenantTables();
  return [
    ...new Set(
      [
        ...migration.matchAll(/ALTER TABLE "([^"]+)" ADD COLUMN "tenant_id"/g),
        ...presetsMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
        ...uploadsMigration.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
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
    expect(migration).not.toContain('WITH CHECK');
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
});
