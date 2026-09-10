import { describe, expect } from 'vitest';
import type { BranchBundleReceipt } from '../../types';
import { EXECUTING_TASK_STATUSES, TaskStatus } from '../../types';
import { dbTest } from '../test-helpers';
import { BranchStorageRepository } from './branch-storage';
import { BranchRepository } from './branches';
import { seedEnvironmentCommandBranch } from './environment-commands.test-support';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';

const receipt: BranchBundleReceipt = {
  bucket: 'disposable',
  key: 'fixture',
  etag: 'opaque-multipart-etag',
  providerChecksum: 'provider',
  sha256: 'a'.repeat(64),
  bytes: 123,
};

describe('branch storage authority', () => {
  dbTest(
    'serializes cooling against filesystem admission and competing cooling requests',
    async ({ db }) => {
      const { branch } = await seedEnvironmentCommandBranch(db);
      await new BranchRepository(db).update(branch.branch_id, { storage_mode: 'clone' });
      const storage = new BranchStorageRepository(db);
      const admission = await storage.admitFilesystem(branch.branch_id);
      await expect(storage.beginCooling(branch.branch_id)).rejects.toThrow('active or unresolved');
      await storage.releaseFilesystem(branch.branch_id, admission);
      const results = await Promise.allSettled([
        storage.beginCooling(branch.branch_id),
        storage.beginCooling(branch.branch_id),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      await expect(storage.admitFilesystem(branch.branch_id)).rejects.toThrow('Restore');
    }
  );

  dbTest(
    'requires receipt before cleanup, preserves uncertain states, and fences stale reports',
    async ({ db }) => {
      const { branch } = await seedEnvironmentCommandBranch(db);
      const branches = new BranchRepository(db);
      await branches.update(branch.branch_id, { storage_mode: 'clone' });
      const storage = new BranchStorageRepository(db);
      const pack = await storage.beginCooling(branch.branch_id);
      const id = pack.operationId!;
      await expect(storage.finishCooling(branch.branch_id, id)).rejects.toThrow('changed');
      await storage.saveReceipt(branch.branch_id, id, receipt);
      await storage.fail(branch.branch_id, id, 'cleanup', 'Interrupted cleanup');
      expect(await storage.get(branch.branch_id)).toMatchObject({ residency: 'cooling', receipt });
      await expect(branches.delete(branch.branch_id)).rejects.toThrow('Restore');
      await storage.finishCooling(branch.branch_id, id);
      const restoring = await storage.beginRestore(branch.branch_id);
      await expect(storage.beginRestore(branch.branch_id)).rejects.toThrow('not ready');
      await expect(storage.finishRestore(branch.branch_id, id)).rejects.toThrow('changed');
      await storage.fail(
        branch.branch_id,
        restoring.operationId!,
        'restoring',
        'Interrupted download'
      );
      expect(await storage.get(branch.branch_id)).toMatchObject({ residency: 'warming', receipt });
      await storage.markPublishing(branch.branch_id, restoring.operationId!);
      await storage.finishRestore(branch.branch_id, restoring.operationId!);
      const visible = await branches.findById(branch.branch_id);
      expect(visible?.workspace_storage?.residency).toBe('warm');
      expect(visible?.workspace_storage).not.toHaveProperty('receipt');
      expect(visible?.workspace_storage).not.toHaveProperty('admissions');
    }
  );

  dbTest(
    'pre-cleanup failure returns to warm; native worktrees and active environments refuse cooling',
    async ({ db }) => {
      const { branch } = await seedEnvironmentCommandBranch(db);
      const branches = new BranchRepository(db);
      const storage = new BranchStorageRepository(db);
      await expect(storage.beginCooling(branch.branch_id)).rejects.toThrow('self-contained clone');
      await branches.update(branch.branch_id, {
        storage_mode: 'clone',
        environment_instance: { status: 'running' },
      });
      await expect(storage.beginCooling(branch.branch_id)).rejects.toThrow('stop the environment');
      await branches.update(branch.branch_id, { environment_instance: { status: 'stopped' } });
      const pack = await storage.beginCooling(branch.branch_id);
      await storage.fail(branch.branch_id, pack.operationId!, 'packing', 'Upload rejected');
      expect((await storage.get(branch.branch_id)).residency).toBe('warm');
    }
  );
});

dbTest(
  'refuses every executing status across sessions, including dispatching, stopping and waiting',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    await new BranchRepository(db).update(branch.branch_id, { storage_mode: 'clone' });
    const storage = new BranchStorageRepository(db);
    const tasks = new TaskRepository(db);
    for (const status of EXECUTING_TASK_STATUSES) {
      const session = await new SessionRepository(db).create({
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
      });
      const task = await tasks.create({
        session_id: session.session_id,
        created_by: user.user_id,
        full_prompt: 'fixture',
        status,
      });
      await expect(storage.beginCooling(branch.branch_id)).rejects.toThrow('Finish running tasks');
      await tasks.update(task.task_id, { status: TaskStatus.COMPLETED });
    }
    for (const status of ['starting', 'error'] as const) {
      await new BranchRepository(db).update(branch.branch_id, { environment_instance: { status } });
      await expect(storage.beginCooling(branch.branch_id)).rejects.toThrow('stop the environment');
    }
  }
);

dbTest(
  'cold prompts retain queue order/cancellation and cannot dispatch until verified publication',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const branches = new BranchRepository(db);
    await branches.update(branch.branch_id, { storage_mode: 'clone' });
    const storage = new BranchStorageRepository(db);
    const session = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'claude-code',
    });
    const tasks = new TaskRepository(db);
    const enqueue = () =>
      tasks.createPending({
        session_id: session.session_id,
        created_by: user.user_id,
        full_prompt: 'fixture',
        status: TaskStatus.QUEUED,
      });
    const cooling = await storage.beginCooling(branch.branch_id);
    await expect(enqueue()).rejects.toThrow('retry shortly');
    await storage.saveReceipt(branch.branch_id, cooling.operationId!, receipt);
    await storage.finishCooling(branch.branch_id, cooling.operationId!);
    await expect(new RepoRepository(db).delete(branch.repo_id)).rejects.toThrow('Restore');
    const first = await enqueue();
    const second = await enqueue();
    const claim = (id: string) =>
      tasks.claimDispatchAndProjectSession(id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      });
    expect((await claim(first.task_id)).outcome).toBe('condition_changed');
    const restore = await storage.beginRestore(branch.branch_id);
    await tasks.delete(first.task_id);
    expect((await claim(second.task_id)).outcome).toBe('condition_changed');
    await storage.markPublishing(branch.branch_id, restore.operationId!);
    expect((await claim(second.task_id)).outcome).toBe('condition_changed');
    await storage.finishRestore(branch.branch_id, restore.operationId!);
    expect((await claim(second.task_id)).outcome).toBe('claimed');
    await expect(storage.beginCooling(branch.branch_id)).rejects.toThrow('Finish running tasks');
  }
);
