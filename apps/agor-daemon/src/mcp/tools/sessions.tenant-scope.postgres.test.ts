import {
  acquireTenantWriteGate,
  createDatabase,
  type Database,
  executeRaw,
  initializeDatabase,
  isPostgresDatabase,
  releaseTenantWriteGate,
  runWithTenantDatabaseScope,
  sql,
  UsersRepository,
} from '@agor/core/db';
import type { TenantID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateId } from '../../../../../packages/core/src/lib/ids';
import { childAdmissionFixture } from '../../../test/session-child-admission';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)('MCP child admission (PostgreSQL/RLS)', () => {
  let rawDb: Database;

  beforeAll(async () => {
    vi.stubEnv('AGOR_BASE_URL', 'http://agor.test');
    rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(rawDb);
    if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL required');
    const result = await executeRaw(
      rawDb,
      sql`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `
    );
    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('admits a shared caller but rejects replay of the same parent ID from another tenant', async () => {
    const tenantA = `spawn-a-${generateId()}` as TenantID;
    const tenantB = `spawn-b-${generateId()}` as TenantID;
    const f = await childAdmissionFixture(rawDb, 'branch', tenantA);
    await f.sharing();
    const foreignUser = await runWithTenantDatabaseScope(f.db, tenantB, (db) =>
      new UsersRepository(db).create({ email: `${tenantB}@example.invalid`, role: 'superadmin' })
    );
    const args = { prompt: 'RLS smoke', enableCallback: false, mcpServerIds: [] };
    const allowed = f.toolsFor(f.caller);
    await allowed.handlers.agor_sessions_spawn(args);
    expect(f.prompt).toHaveBeenCalledOnce();
    expect(await f.count()).toHaveLength(2);

    const denied = f.toolsFor(foreignUser, tenantB);
    // Same real parent ID, real tenant-B principal (even superadmin), RLS on.
    await expect(denied.handlers.agor_sessions_spawn(args)).rejects.toThrow(/not found/i);
    await expect(
      denied.handlers.agor_sessions_prompt({
        ...args,
        sessionId: f.parent.session_id,
        mode: 'subsession',
      })
    ).rejects.toThrow(/not found/i);
    expect(await f.count()).toHaveLength(2);
    expect(f.prompt).toHaveBeenCalledOnce();
  });

  it('enforces the tenant write freeze before custom spawn/fork and resumes only after release', async () => {
    const tenant = `spawn-freeze-${generateId()}` as TenantID;
    const f = await childAdmissionFixture(rawDb, 'branch', tenant);
    const { generation } = await acquireTenantWriteGate(rawDb, tenant, {
      holder: 'spawn-test',
      reason: 'test child admission freeze',
    });
    const { handlers } = f.toolsFor();
    const args = { prompt: 'Freeze smoke', enableCallback: false, mcpServerIds: [] };
    try {
      await expect(handlers.agor_sessions_spawn(args)).rejects.toThrow(/write-gated/i);
      await expect(
        handlers.agor_sessions_prompt({
          ...args,
          sessionId: f.parent.session_id,
          mode: 'fork',
        })
      ).rejects.toThrow(/write-gated/i);
      expect(await f.count()).toHaveLength(1);
      expect(f.prompt).not.toHaveBeenCalled();
    } finally {
      await releaseTenantWriteGate(rawDb, tenant, { generation });
    }
    await handlers.agor_sessions_spawn(args);
    expect(await f.count()).toHaveLength(2);
    expect(f.prompt).toHaveBeenCalledOnce();
  });
});
