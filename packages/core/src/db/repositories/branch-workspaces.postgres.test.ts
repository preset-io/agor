import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { TenantID } from '../../types';
import { BranchWorkspaceCoordinator } from '../../workspaces/coordinator';
import { LocalWorkspaceBlobs } from '../../workspaces/local-blobs';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantContext, runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchWorkspaceRepository } from './branch-workspaces';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'PostgreSQL workspace row locks and RLS',
  () => {
    let db: Database;
    let root: string;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
      root = await mkdtemp(path.join(tmpdir(), 'agor-workspace-pg-'));
    }, 30000);
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    it('serializes independent coordinators and denies another tenant the same branch', async () => {
      const tenantId = `workspace-${generateId()}` as TenantID;
      const branch = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.com`,
          name: 'Workspace',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: `workspace-${generateId()}`,
          name: 'workspace',
          repo_type: 'remote',
          remote_url: 'https://example.com/repo',
          local_path: root,
          default_branch: 'main',
        });
        return new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'main',
          ref: 'main',
          path: root,
          branch_unique_id: Date.now() % 1000000,
          created_by: user.user_id,
        });
      });
      const scope = { tenantId, branchId: branch.branch_id };
      const source = path.join(root, 'source');
      await mkdir(source);
      await writeFile(path.join(source, 'a'), 'original');
      const options = {
        root: path.join(root, 'host'),
        host: 'one',
        leaseMs: 60000,
        toolLeaseMs: 30000,
        clone: 'copy' as const,
        maximumBytes: 1000000,
        maximumFiles: 1000,
        minimumFreeBytes: 0,
        minimumFreeInodes: 0,
        maximumActiveTools: 8,
        maximumReceipts: 100,
        exclude: [],
      };
      const blobs = new LocalWorkspaceBlobs(path.join(root, 'objects'), tenantId);
      await runWithTenantContext(tenantId, async () => {
        const one = new BranchWorkspaceCoordinator(
          scope,
          new BranchWorkspaceRepository(db, scope),
          blobs,
          options
        );
        const two = new BranchWorkspaceCoordinator(
          scope,
          new BranchWorkspaceRepository(db, scope),
          blobs,
          options
        );
        await one.materialise(source);
        const [a, b] = await Promise.all([
          one.beginTool('a', 'a', 'a'),
          two.beginTool('b', 'b', 'b'),
        ]);
        await writeFile(path.join(a.workspace, 'one'), 'one');
        await writeFile(path.join(b.workspace, 'two'), 'two');
        const outcomes = await Promise.all([
          one.completeTool(a.ticket),
          two.completeTool(b.ticket),
        ]);
        expect(outcomes.every((o) => o.status === 'committed')).toBe(true);
        expect((await one.metadata.read()).state?.revision).toBe(2);
        // JSONB reorders object keys; retry identity must compare fields, not serialized order.
        expect(await one.completeTool(a.ticket)).toEqual(outcomes[0]);
      });
      const foreign = { tenantId: 'other-tenant' as TenantID, branchId: branch.branch_id };
      await runWithTenantContext(foreign.tenantId, async () => {
        await expect(new BranchWorkspaceRepository(db, foreign).read()).rejects.toThrow(
          'not found'
        );
      });
    });
  }
);
