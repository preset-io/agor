import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { BranchWorkspaceRepository } from '../db/repositories/branch-workspaces';
import { BranchRepository } from '../db/repositories/branches';
import { RepoRepository } from '../db/repositories/repos';
import { runWithTenantContext } from '../db/tenant-context';
import { ownedDbTest } from '../db/test-helpers';
import { generateId } from '../lib/ids';
import type { BranchID, TenantID, UUID } from '../types';
import { BranchWorkspaceCoordinator } from './coordinator';
import { LocalWorkspaceBlobs } from './local-blobs';
import { runWorkspaceTool } from './tool-boundary';

function tool(cwd: string, filename: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
        filename,
        content,
      ],
      { cwd, env: {}, stdio: 'pipe' }
    );
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Tool exited ${code}`))
    );
  });
}
ownedDbTest(
  'two actual executor processes publish, conflict and restore through the SQL authority',
  async ({ db }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agor-real-tools-'));
    try {
      const source = path.join(root, 'source');
      await mkdir(source);
      await writeFile(path.join(source, 'a'), 'initial');
      const repo = await new RepoRepository(db).create({
        repo_id: generateId(),
        slug: 'real-tools',
        name: 'real-tools',
        repo_type: 'remote',
        remote_url: 'https://example.com/repo',
        local_path: source,
        default_branch: 'main',
      });
      const branch = await new BranchRepository(db).create({
        branch_id: generateId() as BranchID,
        repo_id: repo.repo_id,
        name: 'main',
        created_by: 'test-user' as UUID,
        ref: 'main',
        path: source,
        branch_unique_id: 1,
      });
      const scope = { tenantId: 'tenant-a' as TenantID, branchId: branch.branch_id };
      await runWithTenantContext(scope.tenantId, async () => {
        const metadata = new BranchWorkspaceRepository(db, scope);
        const blobs = new LocalWorkspaceBlobs(path.join(root, 'objects'), scope.tenantId);
        const options = {
          root: path.join(root, 'host-a'),
          host: 'host-a',
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
        const c = new BranchWorkspaceCoordinator(scope, metadata, blobs, options);
        await c.materialise(source);
        // Barrier ensures both processes start at revision zero.
        let ready = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const run = (executorId: string, file: string) =>
          runWorkspaceTool(
            c,
            { executorId, toolId: executorId, idempotencyKey: executorId },
            async ({ cwd, ticket }) => {
              expect(ticket.baseRevision).toBe(0);
              if (++ready === 2) release();
              await gate;
              await tool(cwd, file, executorId);
            }
          );
        const outcomes = await Promise.all([run('one', 'a'), run('two', 'b')]);
        expect(outcomes.every((o) => o.outcome.status === 'committed')).toBe(true);
        const a = await c.beginTool('one', 'conflict-a', 'conflict-a');
        const b = await c.beginTool('two', 'conflict-b', 'conflict-b');
        expect(await readFile(path.join(a.workspace, 'b'), 'utf8')).toBe('two');
        await Promise.all([tool(a.workspace, 'a', 'winner'), tool(b.workspace, 'a', 'loser')]);
        await c.completeTool(a.ticket);
        expect(await c.completeTool(b.ticket)).toMatchObject({ status: 'conflict' });
        await c.drain();
        const replacement = new BranchWorkspaceCoordinator(
          scope,
          new BranchWorkspaceRepository(db, scope),
          blobs,
          { ...options, root: path.join(root, 'host-b'), host: 'host-b' }
        );
        expect(await replacement.restore()).toBe(3);
        const restored = await replacement.beginTool('three', 'read', 'read');
        expect(await readFile(path.join(restored.workspace, 'a'), 'utf8')).toBe('winner');
        expect(await readFile(path.join(restored.workspace, 'b'), 'utf8')).toBe('two');
        await replacement.abortTool(restored.ticket);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
