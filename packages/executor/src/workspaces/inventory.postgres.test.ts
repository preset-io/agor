import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceInventory } from './inventory';
import type { WorkerInventory } from './placement';

const url = process.env.AGOR_WORKSPACE_POSTGRES_URL;
describe.skipIf(!url)('worker inventory SQL isolation', () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4 });
    const [role] = await sql`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
    await sql.unsafe(
      await readFile(
        path.resolve(import.meta.dirname, '../../../../infra/agor-test/workspace-inventory.sql'),
        'utf8'
      )
    );
  });
  afterAll(async () => {
    await sql?.end();
  });
  it('advertises only within the requested tenant and uses server time', async () => {
    const id = crypto.randomUUID();
    const a = new WorkspaceInventory('/unused', sql, id);
    const inventory: WorkerInventory = {
      origin: id,
      incarnation: 'test',
      freeBytes: 100,
      freeInodes: 100,
      totalBytes: 100,
      totalInodes: 100,
      freeSlots: 1,
      freeCpu: 1,
      freeMemoryBytes: 1,
      accepting: true,
      residents: [],
    };
    await a.advertise('inventory-a', inventory);
    expect((await a.candidates('inventory-a')).find((w) => w.origin === id)).toMatchObject({
      ageMs: expect.any(Number),
    });
    expect((await a.candidates('inventory-b')).find((w) => w.origin === id)).toBeUndefined();
    const unscoped = await sql`select * from agor_workspace_inventory where worker_id=${id}`;
    expect(unscoped).toHaveLength(0);
  });
});
