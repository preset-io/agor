// @vitest-environment node
import type { UserID } from '@agor-live/client';
import { afterEach, expect, vi } from 'vitest';
import { BranchRepository } from '../../../../packages/core/src/db/repositories/branches';
import { RepoRepository } from '../../../../packages/core/src/db/repositories/repos';
import { SessionRepository } from '../../../../packages/core/src/db/repositories/sessions';
import { ownedDbTest as dbTest } from '../../../../packages/core/src/db/test-helpers';
import { buildSessionMaps } from './agorMaps';
import { sessionPatched } from './agorRealtimeActions';
import { agorStore } from './agorStore';
import { captureSessionPatchCommit, setRealtimeAuthorityScope } from './realtimeBatch';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

for (const restoreAfterArchive of [false, true]) {
  dbTest(
    `repository write order beats timestamps (later restore=${restoreAfterArchive})`,
    async ({ db }) => {
      const repo = await new RepoRepository(db).create({
        slug: 'test/archive-order',
        name: 'Archive order',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/repo.git',
        default_branch: 'main',
        local_path: '/tmp/archive-order',
      });
      const branch = await new BranchRepository(db).create({
        repo_id: repo.repo_id,
        name: 'main',
        ref: 'main',
        path: '/tmp/archive-order',
        base_ref: 'main',
        new_branch: false,
        branch_unique_id: 1,
        created_by: 'test-user' as UserID,
      });
      const repository = new SessionRepository(db);
      const parent = await repository.create({
        branch_id: branch.branch_id,
        agentic_tool: 'codex',
        status: 'idle',
        created_by: 'test-user',
      });
      const child = await repository.create({
        branch_id: branch.branch_id,
        agentic_tool: 'codex',
        status: 'idle',
        created_by: 'test-user',
        genealogy: { parent_session_id: parent.session_id, children: [] },
      });
      const rows = [parent, child];
      agorStore.getState().applyMaps((prev) => ({ ...prev, ...buildSessionMaps(rows) }));
      setRealtimeAuthorityScope('tenant-a:user-a:1');
      const commit = captureSessionPatchCommit();

      // Delay entry to the real transaction, AFTER the repository captures `now`.
      // The other real repository write commits first with a later timestamp.
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const atTransaction = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const transaction = db.transaction;
      vi.spyOn(db, 'transaction').mockImplementationOnce(
        async (...args: Parameters<typeof db.transaction>) => {
          entered();
          await gate;
          return Reflect.apply(transaction, db, args) as ReturnType<typeof db.transaction>;
        }
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-18T17:04:49.250Z'));
      const archiving = repository.updateArchiveStateForIds(
        rows.map((row) => row.session_id),
        true,
        'manual'
      );
      await atTransaction;
      vi.setSystemTime(new Date('2026-09-18T17:04:49.284Z'));
      for (const row of rows) {
        const active = await repository.update(row.session_id, { title: 'Updated first' });
        sessionPatched(active);
      }
      release();
      const archived = await archiving;
      expect(archived[0].last_updated).toBe('2026-09-18T17:04:49.250Z');
      expect(agorStore.getState().sessionById.get(parent.session_id)?.last_updated).toBe(
        '2026-09-18T17:04:49.284Z'
      );
      expect((await repository.findById(parent.session_id))?.archived).toBe(true);

      if (restoreAfterArchive) {
        vi.setSystemTime(new Date('2026-09-18T17:04:49.300Z'));
        const restored = await repository.updateArchiveStateForIds(
          rows.map((row) => row.session_id),
          false,
          null
        );
        restored.forEach(sessionPatched);
      }
      // The original archive response arrives only now, after the optional restore.
      await commit(archived, async (id) => {
        const fresh = await repository.findById(id);
        if (!fresh) throw new Error('Missing test session');
        return fresh;
      });
      const database = await repository.findById(parent.session_id);
      expect(database?.archived).toBe(!restoreAfterArchive);
      expect(agorStore.getState().sessionById.has(parent.session_id)).toBe(restoreAfterArchive);
      expect(agorStore.getState().sessionById.has(child.session_id)).toBe(restoreAfterArchive);
    }
  );
}
