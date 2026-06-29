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

function postgresMigrationSql(): string {
  const migrationsDir = path.join(repoRoot, 'packages/core/drizzle/postgres');
  return fs
    .readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => fs.readFileSync(path.join(migrationsDir, entry), 'utf8'))
    .join('\n');
}

function migrationTenantTables(): string[] {
  const migration = postgresMigrationSql();
  const tables = new Set<string>();

  for (const match of migration.matchAll(/ALTER TABLE "([^"]+)" ADD COLUMN "tenant_id"/g)) {
    tables.add(match[1]);
  }

  for (const match of migration.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g)) {
    const [, tableName, columnsBlock] = match;
    if (columnsBlock.includes('"tenant_id" text')) tables.add(tableName);
  }

  return [...tables].sort();
}

function rlsPolicyTables(): string[] {
  const migration = postgresMigrationSql();
  return [
    ...new Set(
      [...migration.matchAll(/CREATE POLICY "tenant_isolation_([^"]+)" ON "([^"]+)"/g)].map(
        (m) => m[2]
      )
    ),
  ].sort();
}

describe('Postgres multitenancy schema coverage', () => {
  it('keeps tenant columns, tenant migration, and RLS policies in sync', () => {
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
});
