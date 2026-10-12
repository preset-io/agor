import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { reconcileBranchDeletionReferencesBatch } from './branch-deletion-references';
import { exerciseWideDeletionReferences } from './branch-deletion-references.test-support';
import { createDatabase } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { runMigrations } from './migrate';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { SessionRepository } from './repositories/sessions';
import { TaskRepository } from './repositories/tasks';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'reconciles wide rows through scoped repositories without crossing tenants',
  async () => {
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    try {
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await runMigrations(db, { allowOfflineCutover: true });
      const guarded = createTenantScopedDatabaseProxy(db, { requireScope: true });
      const tenant = `wide-${generateId()}`;
      const fixture = await runWithTenantDatabaseScope(
        guarded,
        tenant,
        exerciseWideDeletionReferences
      );
      await runWithTenantDatabaseScope(guarded, `foreign-${generateId()}`, async (scoped) => {
        expect(await new BranchRepository(scoped).findById(fixture.branch.branch_id)).toBeNull();
        const { branch, user } = await seedEnvironmentCommandBranch(scoped);
        const foreign = await new SessionRepository(scoped).create({
          branch_id: branch.branch_id,
          created_by: user.user_id,
          genealogy: { children: [fixture.owned.session_id] },
        });
        // Exercise the scanner as well as repository reads in the wrong scope.
        for (let table = 0; table < 5; table++) {
          await reconcileBranchDeletionReferencesBatch(scoped, fixture.branch.branch_id, { table });
        }
        expect(
          (await new SessionRepository(scoped).findById(foreign.session_id))?.genealogy.children
        ).toEqual([fixture.owned.session_id]);
      });
      // Independent transactions: the writer queues behind the scanner's row
      // lock, then merges metadata into the scrubbed row rather than restoring
      // a stale completion callback or losing its own unrelated metadata.
      const peer = createDatabase({ dialect: 'postgresql', url: url! });
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let scanned = () => {};
      const ready = new Promise<void>((resolve) => {
        scanned = resolve;
      });
      let scanning: Promise<unknown> | undefined;
      let writing: Promise<unknown> | undefined;
      try {
        await runWithTenantDatabaseScope(guarded, tenant, async (scoped) => {
          await new TaskRepository(scoped).update(fixture.task.task_id, {
            metadata: {
              completion_callback: {
                target_session_id: fixture.owned.session_id,
                requested_from_session_id: fixture.parent.session_id,
                requested_by_user_id: fixture.parent.created_by,
              },
              callback_dispatches: fixture.children.map((id) => ({
                event: 'task_completion',
                target_session_id: id,
                dispatched_at: new Date().toISOString(),
              })),
            },
          });
        });
        scanning = runWithTenantDatabaseScope(guarded, tenant, async (scoped) => {
          await reconcileBranchDeletionReferencesBatch(scoped, fixture.branch.branch_id, {
            table: 1,
          });
          scanned();
          await held;
        });
        await Promise.race([
          ready,
          scanning.then(() => {
            throw new Error('scan ended before barrier');
          }),
        ]);
        let finished = false;
        let writerPid: number | undefined;
        writing = runWithTenantDatabaseScope(peer, tenant, async (scoped) => {
          writerPid = Number(
            rawRows(await executeRaw(scoped, sql`SELECT pg_backend_pid() AS pid`))[0]!.pid
          );
          await new TaskRepository(scoped).update(fixture.task.task_id, {
            metadata: { gateway_reply_metadata: { marker: 'concurrent' } },
          });
          finished = true;
        });
        await expect
          .poll(
            async () => {
              if (!writerPid) return false;
              return runWithTenantDatabaseScope(guarded, tenant, async (scoped) =>
                Boolean(
                  rawRows(
                    await executeRaw(
                      scoped,
                      sql`SELECT cardinality(pg_blocking_pids(${writerPid})) > 0 AS blocked`
                    )
                  )[0]!.blocked
                )
              );
            },
            { timeout: 5000 }
          )
          .toBe(true);
        expect(finished).toBe(false);
        release();
        await Promise.all([scanning, writing]);
        await runWithTenantDatabaseScope(guarded, tenant, async (scoped) => {
          const task = await new TaskRepository(scoped).findById(fixture.task.task_id);
          expect(task?.metadata?.completion_callback).toBeUndefined();
          expect(task?.metadata?.callback_dispatches).toHaveLength(1001);
          expect(task?.metadata?.gateway_reply_metadata).toEqual({ marker: 'concurrent' });
          expect(
            (await new SessionRepository(scoped).findById(fixture.parent.session_id))?.genealogy
              .children
          ).toEqual([fixture.children[1000], fixture.children[0]]);
        });
      } finally {
        release();
        await Promise.allSettled([scanning, writing]);
        await (peer as typeof peer & { $client: { end(): Promise<void> } }).$client.end();
      }
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  60_000
);
