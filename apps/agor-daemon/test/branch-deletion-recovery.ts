import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  BranchMaintenanceRepository,
  BranchRepository,
  branches,
  createTenantScopedDatabaseProxy,
  type Database,
  eq,
  executeRaw,
  generateId,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
  select,
  sql,
  UploadRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  branchDeletionCommandId,
  type SessionID,
  type TenantID,
  type UploadReadInput,
} from '@agor/core/types';
import { expect } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../packages/core/src/db/repositories/environment-commands.test-support';
import { handleBranchDelete } from '../../../packages/executor/src/commands/branch-deletion';
import {
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../src/auth/executor-session-token';
import { LocalUploadStagingStore } from '../src/host/local/upload-staging-store';
import { BranchDeletionStepsService } from '../src/services/branch-deletion-steps';
import {
  configureUploadStagingStore,
  resetUploadStagingStoreForTests,
} from '../src/utils/upload-staging';

/** Real HTTP requests, guarded DB scopes and real disposable filesystem removal. */
export async function exerciseDeletionRecovery(raw: Database, dialect: 'sqlite' | 'postgresql') {
  const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
  const tenant = `recovery-${generateId()}` as TenantID;
  const scoped = <T>(work: (tx: Database) => Promise<T>) =>
    runWithTenantDatabaseScope(db, tenant, work);
  const root = await mkdtemp(join(tmpdir(), 'agor-delete-recovery-'));
  const app = {
    get: () => ({ execution: {} }),
    service: () => ({ emit: () => {} }),
  } as unknown as Application;
  const service = new BranchDeletionStepsService(db, app);
  let params: AuthenticatedParams;
  let fault:
    | 'none'
    | 'lost_response'
    | 'lost_data_response'
    | 'lost_settlement'
    | 'rollback'
    | 'upload_unknown' = 'none';
  let failures = 0;
  let releaseUpload!: () => void;
  let dropUploadResponse!: () => void;
  let pendingUpload: Promise<unknown> | undefined;
  const storage = new (class extends LocalUploadStagingStore {
    override async delete(input: UploadReadInput) {
      if (fault === 'upload_unknown') {
        await new Promise<void>((resolve) => {
          releaseUpload = resolve;
          dropUploadResponse();
        });
      }
      await super.delete(input);
    }
  })((id) => join(root, 'uploads', id));
  configureUploadStagingStore(() => storage);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (fault === 'upload_unknown' && input.action === 'upload') {
      dropUploadResponse = () => response.destroy();
      pendingUpload = runWithTenantContext(tenant, () => service.create(input, params));
      // It remains live after the executor's HTTP request is gone.
      await pendingUpload;
      return;
    }
    try {
      const result = await runWithTenantContext(tenant, () => service.create(input, params));
      if (
        (fault === 'lost_response' && input.action === 'quiesce') ||
        (fault === 'lost_data_response' && input.action === 'data') ||
        (fault === 'lost_settlement' && input.action === 'settled')
      ) {
        response.destroy();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    } catch {
      failures++;
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const daemonUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const scenario of [
      'rollback',
      'lost_response',
      'lost_data_response',
      'lost_settlement',
      'upload_unknown',
    ] as const) {
      const { branch, user } = await scoped(seedEnvironmentCommandBranch);
      const workspace = join(root, 'worktrees', branch.branch_id);
      const home = join(root, 'branch-homes', branch.branch_id);
      await mkdir(workspace, { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(join(workspace, 'owned.txt'), 'fixture');
      await scoped((tx) => new BranchRepository(tx).update(branch.branch_id, { path: workspace }));
      let removedSessionId: SessionID | undefined;
      if (scenario === 'lost_data_response') {
        removedSessionId = (
          await scoped((tx) =>
            new SessionRepository(tx).create({
              branch_id: branch.branch_id,
              agentic_tool: 'codex',
              created_by: user.user_id,
            })
          )
        ).session_id;
      }
      if (scenario === 'upload_unknown') {
        const session = await scoped((tx) =>
          new SessionRepository(tx).create({
            branch_id: branch.branch_id,
            agentic_tool: 'codex',
            created_by: user.user_id,
          })
        );
        const owner = {
          tenantId: tenant,
          branchId: branch.branch_id,
          sessionId: session.session_id,
          createdBy: user.user_id,
        };
        const metadata = await storage.stage({
          owner,
          name: 'fixture.txt',
          mimeType: 'text/plain',
          provenance: 'browser',
          body: Readable.from('fixture'),
        });
        await scoped((tx) => new UploadRepository(tx).create(owner, metadata));
      }
      const admission = async () =>
        scoped(async (tx) => {
          const maintenance = new BranchMaintenanceRepository(tx);
          const { claim, acquired } = await maintenance.claim(
            branch.branch_id,
            'delete',
            user.user_id
          );
          const invocation = acquired
            ? await maintenance.beginExecution(claim)
            : claim.execution_id!;
          return { claim, invocation, acquired };
        });
      const first = await admission();
      const input = (invocation: typeof first.invocation, claim = first.claim) => ({
        branch_id: branch.branch_id,
        operation_id: claim.operation_id,
        generation: claim.generation,
        execution_id: invocation,
      });
      const authorize = (invocation: typeof first.invocation) => {
        params = {
          provider: 'rest',
          user,
          tenant: { tenant_id: tenant, source: 'explicit' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: EXECUTOR_SESSION_TOKEN_TYPE,
              purpose: EXECUTOR_COMMAND_TOKEN_PURPOSE,
              tenant_id: tenant,
              sub: user.user_id,
              branch_id: branch.branch_id,
              session_id: branchDeletionCommandId(invocation),
            },
          },
        } as AuthenticatedParams;
      };
      authorize(first.invocation);
      // The claimed invocation is tenant-owned, not authorized by UUID shape.
      await runWithTenantContext(tenant, async () => {
        await expect(
          service.create(
            { ...input(first.invocation), action: 'settled' },
            {
              ...params,
              authentication: undefined,
            }
          )
        ).rejects.toThrow('executor credential');
        await expect(
          service.create(
            { ...input(first.invocation), action: 'settled' },
            {
              ...params,
              tenant: { tenant_id: 'foreign' as TenantID, source: 'explicit' },
            }
          )
        ).rejects.toThrow('tenant');
      });
      const run = (execution: typeof first) =>
        handleBranchDelete(
          {
            command: 'branch.delete',
            daemonUrl,
            sessionToken: 'disposable-test-token',
            params: {
              branchId: branch.branch_id,
              operationId: execution.claim.operation_id,
              generation: execution.claim.generation,
              executionId: execution.invocation,
              branchPath: workspace,
              branchesRoot: join(root, 'worktrees'),
              repoPath: root,
              branchHome: home,
              tenantDataRoot: root,
              storageMode: 'clone',
            },
          },
          {}
        );
      // A real database-trigger exception, not a mocked repository rejection.
      if (scenario === 'rollback')
        await scoped(async (tx) => {
          if (dialect === 'sqlite') {
            await executeRaw(
              tx,
              sql.raw(`CREATE TRIGGER recovery_abort BEFORE UPDATE OF data ON branches
            WHEN NEW.branch_id = '${branch.branch_id}' AND json_extract(NEW.data, '$.maintenance.reference_cursor') IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`)
            );
          } else {
            await executeRaw(
              tx,
              sql.raw(`CREATE FUNCTION recovery_abort_fn() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.branch_id = '${branch.branch_id}' AND NEW.data->'maintenance'->'reference_cursor' IS NOT NULL
            THEN RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'fixture rollback'; END IF; RETURN NEW; END $$`)
            );
            await executeRaw(
              tx,
              sql.raw(
                'CREATE TRIGGER recovery_abort BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION recovery_abort_fn()'
              )
            );
          }
        });
      fault = scenario === 'lost_settlement' ? 'lost_response' : scenario;
      // Force a storage-local validation failure so the settlement response can
      // be lost without losing any daemon-side storage request.
      if (scenario === 'lost_settlement') {
        await rm(workspace, { recursive: true });
        await rm(join(root, 'worktrees'), { recursive: true });
        fault = 'lost_settlement';
      }
      expect((await run(first)).success).toBe(false);
      if (scenario === 'rollback')
        await scoped(async (tx) => {
          await executeRaw(
            tx,
            sql.raw(
              dialect === 'sqlite'
                ? 'DROP TRIGGER recovery_abort'
                : 'DROP TRIGGER recovery_abort ON branches'
            )
          );
          if (dialect === 'postgresql')
            await executeRaw(tx, sql.raw('DROP FUNCTION recovery_abort_fn()'));
        });
      const after = await scoped<Pick<
        typeof branches.$inferSelect,
        'data' | 'deletion_status'
      > | null>((tx) =>
        select(tx, { data: branches.data, deletion_status: branches.deletion_status })
          .from(branches)
          .where(eq(branches.branch_id, branch.branch_id))
          .one()
      );
      expect(after).not.toBeNull();
      if (scenario === 'upload_unknown') {
        expect(after!.data.maintenance?.execution_id).toBe(first.invocation);
        expect((await admission()).acquired).toBe(false);
        releaseUpload();
        await pendingUpload;
        // Completion in the old daemon does not retroactively manufacture a
        // worker settlement acknowledgement. An authorized retry still holds.
        expect((await admission()).acquired).toBe(false);
        continue;
      }
      expect(after!.deletion_status).toBe('deletion_failed');
      expect(after!.data.maintenance).toBeUndefined();
      if (removedSessionId) {
        expect(
          await scoped((tx) => new SessionRepository(tx).findById(removedSessionId!))
        ).toBeNull();
      }
      // Partial commits remain deleted. A replacement starts from authoritative
      // remaining rows and must verify storage anew, never reuse old flags.
      fault = 'none';
      await mkdir(join(root, 'worktrees'), { recursive: true });
      const contenders = await Promise.all([admission(), admission()]);
      expect(contenders.filter((entry) => entry.acquired)).toHaveLength(1);
      const retry = contenders.find((entry) => entry.acquired)!;
      expect(retry.claim.generation).toBe(first.claim.generation + 1);
      await runWithTenantContext(tenant, async () => {
        for (const action of ['quiesce', 'storage', 'data', 'settled', 'claim'])
          await expect(
            service.create({ ...input(first.invocation), action }, params)
          ).rejects.toThrow();
      });
      authorize(retry.invocation);
      expect((await run(retry)).success).toBe(true);
      expect(await scoped((tx) => new BranchRepository(tx).findById(branch.branch_id))).toBeNull();
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(failures).toBeGreaterThan(0);
  } finally {
    releaseUpload?.();
    await pendingUpload;
    resetUploadStagingStoreForTests();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await rm(root, { recursive: true, force: true });
  }
}
