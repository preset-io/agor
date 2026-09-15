/** Test-only, run-owned cluster: role DDL never targets a supplied database URL. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { createDatabase, type Database } from '../client';
import { runMigrations } from '../migrate';

const command = promisify(execFile);
const label = 'agor.managed-oauth-test-run';
const image = 'pgvector/pgvector:0.8.2-pg16-trixie';

export async function assertNonOwnerPostgres(client: postgres.Sql): Promise<void> {
  const [role] = await client`
    SELECT session_user = current_user AS same_role, rolsuper, rolbypassrls,
      rolcreaterole, rolcreatedb,
      EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
          AND pg_has_role(current_user, c.relowner, 'MEMBER')
      ) AS owns_or_inherits
    FROM pg_roles WHERE rolname = current_user`;
  if (
    !role?.same_role ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.owns_or_inherits
  ) {
    throw new Error('Managed OAuth test requires a non-owner, non-BYPASSRLS runtime role');
  }
}

export interface OwnedPostgres {
  db: Database;
  peer: Database;
  sql: postgres.Sql;
  dispose(): Promise<void>;
}

/** No external endpoint option exists: the container ID is the ownership proof. */
export async function createOwnedPostgres(): Promise<OwnedPostgres> {
  const run = randomUUID().replaceAll('-', '');
  const role = `runtime_${run}`;
  const password = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'agor-owned-pg-'));
  const manifest = join(directory, 'owner.json');
  let container: string | undefined;
  let bootstrap: postgres.Sql | undefined;
  let migrationDb: Database | undefined;
  const clients: postgres.Sql[] = [];
  const close = async () => {
    await Promise.all(clients.map((client) => client.end({ timeout: 2 })));
    if (migrationDb) {
      await (migrationDb as Database & { $client: postgres.Sql }).$client.end({ timeout: 2 });
    }
    await bootstrap?.end({ timeout: 2 });
    if (container) {
      const ownership = JSON.parse(await readFile(manifest, 'utf8'));
      const { stdout } = await command('docker', [
        'inspect',
        '--format',
        `{{index .Config.Labels "${label}"}}`,
        container,
      ]);
      if (ownership.run !== run || ownership.container !== container || stdout.trim() !== run) {
        throw new Error('Refusing cleanup of an unowned PostgreSQL cluster');
      }
      await command('docker', ['rm', '--force', '--volumes', container]);
      container = undefined;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const { stdout } = await command(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--label',
        `${label}=${run}`,
        '--publish',
        '127.0.0.1::5432',
        '--tmpfs',
        '/var/lib/postgresql/data:rw',
        '--env',
        'POSTGRES_DB=agor',
        '--env',
        'POSTGRES_USER=bootstrap',
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        image,
      ],
      { timeout: 120_000 }
    );
    container = stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid owned container identity');
    await writeFile(manifest, JSON.stringify({ run, container }), { mode: 0o600 });
    const { stdout: port } = await command('docker', ['port', container, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(port);
    if (!match) throw new Error('Owned cluster must expose only loopback');
    const base = `127.0.0.1:${match[1]}/agor`;
    const ownerUrl = `postgresql://bootstrap:${password}@${base}`;
    bootstrap = postgres(ownerUrl, { max: 1, connect_timeout: 1, onnotice: () => {} });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await bootstrap`SELECT 1`;
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error('Owned PostgreSQL cluster did not become ready');
    await bootstrap`CREATE EXTENSION IF NOT EXISTS vector`;
    migrationDb = createDatabase({ dialect: 'postgresql', url: ownerUrl });
    await runMigrations(migrationDb);
    await bootstrap.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`
    );
    await bootstrap.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await bootstrap.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`
    );
    await bootstrap.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    // Runtime deletion checks only read the migration receipt, never mutate it.
    await bootstrap.unsafe(`GRANT USAGE ON SCHEMA drizzle TO ${role}`);
    await bootstrap.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${role}`);
    const url = `postgresql://${role}:${password}@${base}`;
    const db: Database = createDatabase({ dialect: 'postgresql', url });
    const peer: Database = createDatabase({ dialect: 'postgresql', url });
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    clients.push(
      (db as Database & { $client: postgres.Sql }).$client,
      (peer as Database & { $client: postgres.Sql }).$client,
      sql
    );
    await assertNonOwnerPostgres(sql);
    return { db, peer, sql, dispose: close };
  } catch (error) {
    await close();
    throw error;
  }
}
