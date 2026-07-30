import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

// Migrations that introduce a tenant-owned table after the 0054/0055 rollout.
// Each must both create the `tenant_id` column and install the RLS policy.
const TENANT_TABLE_CREATING_MIGRATIONS = [
  'packages/core/drizzle/postgres/0059_agentic_tool_presets.sql',
  'packages/core/drizzle/postgres/0068_uploads.sql',
  'packages/core/drizzle/postgres/0070_kb_document_comments.sql',
];

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
  const tenantTableCreatingMigrations =
    TENANT_TABLE_CREATING_MIGRATIONS.map(readRepoFile).join('\n');
  const retiredTables = retiredTenantTables();
  return [
    ...new Set(
      [
        ...migration.matchAll(/ALTER TABLE "([^"]+)" ADD COLUMN "tenant_id"/g),
        ...tenantTableCreatingMigrations.matchAll(/CREATE TABLE "([^"]+)" \([\s\S]*?"tenant_id"/g),
      ]
        .map((m) => m[1])
        .filter((table) => !retiredTables.has(table))
    ),
  ].sort();
}

function rlsPolicyTables(): string[] {
  const migration = [
    readRepoFile('packages/core/drizzle/postgres/0055_app_level_multitenancy_rls.sql'),
    ...TENANT_TABLE_CREATING_MIGRATIONS.map(readRepoFile),
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
});
