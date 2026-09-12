import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BranchID, TenantID } from '@agor/core/types';
import { BranchWorkspaceCoordinator, LocalWorkspaceBlobs } from '@agor/core/workspaces';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerSqlAuthority } from './sql-authority';

const url = process.env.AGOR_WORKSPACE_POSTGRES_URL;
describe.skipIf(!url)('worker SQL authority', () => {
  let sql: postgres.Sql;
  let root: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 8 });
    const [role] = await sql`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
    await sql.unsafe(
      await readFile(
        path.resolve(import.meta.dirname, '../../../../infra/agor-test/workspace-authority.sql'),
        'utf8'
      )
    );
    root = await mkdtemp(path.join(tmpdir(), 'worker-authority-'));
  });
  afterAll(async () => {
    await sql?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('atomically merges disjoint writers, rejects conflicts, fences takeover and isolates tenants', async () => {
    const scope = {
      tenantId: 'tenant-a' as TenantID,
      branchId: '01900000-0000-7000-8000-000000000001' as BranchID,
    };
    const metadata = new WorkerSqlAuthority(sql, scope);
    const other = new WorkerSqlAuthority(sql, scope);
    const blobs = new LocalWorkspaceBlobs(path.join(root, 'blobs'), scope.tenantId);
    const options = {
      root: path.join(root, 'host-a'),
      host: 'host-a',
      leaseMs: 60000,
      toolLeaseMs: 60000,
      clone: 'copy' as const,
      maximumBytes: 1000000,
      maximumFiles: 1000,
      minimumFreeBytes: 0,
      minimumFreeInodes: 0,
      maximumActiveTools: 8,
      maximumReceipts: 100,
      exclude: [],
    };
    const c = new BranchWorkspaceCoordinator(scope, metadata, blobs, options);
    const c2 = new BranchWorkspaceCoordinator(scope, other, blobs, options);
    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'a'), 'base');
    await c.materialise(source);
    const a = await c.beginTool('a', 'a', 'a'),
      b = await c2.beginTool('b', 'b', 'b');
    await writeFile(path.join(a.workspace, 'a'), 'one');
    await writeFile(path.join(b.workspace, 'b'), 'two');
    const results = await Promise.all([c.completeTool(a.ticket), c2.completeTool(b.ticket)]);
    expect(results.map((r) => r.status)).toEqual(['committed', 'committed']);
    expect((await metadata.read()).state?.revision).toBe(2);
    const x = await c.beginTool('a', 'x', 'x'),
      y = await c2.beginTool('b', 'y', 'y');
    await writeFile(path.join(x.workspace, 'a'), 'winner');
    await writeFile(path.join(y.workspace, 'a'), 'loser');
    const conflicts = await Promise.all([c.completeTool(x.ticket), c2.completeTool(y.ticket)]);
    expect(conflicts.filter((r) => r.status === 'conflict')).toHaveLength(1);
    await c.checkpoint();
    const stale = await c.beginTool('stale', 'stale', 'stale');
    await metadata.mutate((state, now) => ({
      state: { ...state!, leaseUntil: now - 1 },
      result: undefined,
    }));
    const replacement = new BranchWorkspaceCoordinator(scope, other, blobs, {
      ...options,
      root: path.join(root, 'host-b'),
      host: 'host-b',
    });
    expect(await replacement.restore()).toBe(3);
    await expect(c.completeTool(stale.ticket)).rejects.toThrow('lease');
    expect(
      (await new WorkerSqlAuthority(sql, { ...scope, tenantId: 'tenant-b' as TenantID }).read())
        .state
    ).toBeNull();
    expect(await sql`select * from agor_workspace_authority`).toHaveLength(0);
  });
});
