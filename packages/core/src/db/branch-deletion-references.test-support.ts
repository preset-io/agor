import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, vi } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchDeletionReferenceCursor, SessionID, TeammateKnowledgeGrant } from '../types';
import { reconcileBranchDeletionReferencesBatch } from './branch-deletion-references';
import type { Database } from './client';
import * as databaseWrapper from './database-wrapper';
import {
  executeRaw,
  insert,
  isPostgresDatabase,
  rawRows,
  runDatabaseTransaction,
} from './database-wrapper';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { KnowledgeNamespaceRepository } from './repositories/knowledge';
import { SessionRepository } from './repositories/sessions';
import { TaskRepository } from './repositories/tasks';
import { kbNamespaces } from './schema';

/** Same real-repository regression on SQLite and tenant-scoped non-superuser PG. */
export async function exerciseWideDeletionReferences(db: Database) {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const { branch: survivor } = await seedEnvironmentCommandBranch(db);
  const sessions = new SessionRepository(db);
  const tasks = new TaskRepository(db);
  const namespaces = new KnowledgeNamespaceRepository(db);
  const parent = await sessions.create({ branch_id: survivor.branch_id, created_by: user.user_id });
  const owned = await sessions.create({ branch_id: branch.branch_id, created_by: user.user_id });
  const ownedTask = await tasks.create({ session_id: owned.session_id, created_by: user.user_id });
  const ownedNamespace = await namespaces.create({
    slug: 'owned',
    kind: 'branch',
    branch_id: branch.branch_id,
  });
  const children: SessionID[] = [];
  // Batch fixture writes, not the scanner pages: avoid thousands of SQLite
  // fsyncs while still creating genuine rows through the scoped repositories.
  await runDatabaseTransaction(
    db,
    async (tx) => {
      for (let i = 0; i < 1001; i++) {
        children.push(
          (
            await new SessionRepository(tx).create({
              branch_id: survivor.branch_id,
              created_by: user.user_id,
              genealogy: { parent_session_id: parent.session_id, children: [] },
            })
          ).session_id
        );
      }
    },
    { sqliteImmediate: true }
  );

  const scan = async (table = 0, onePage = false) => {
    let cursor: BranchDeletionReferenceCursor = { table };
    for (let page = 0; ; page++) {
      expect(page).toBeLessThan(100);
      // Observe, don't stub, the real database calls. UNION lists must stay
      // below even SQLite's historical parameter limit for every wide field.
      const queries = vi.spyOn(databaseWrapper, 'executeRaw');
      let result: Awaited<ReturnType<typeof reconcileBranchDeletionReferencesBatch>>;
      try {
        result = await runDatabaseTransaction(
          db,
          (tx) => reconcileBranchDeletionReferencesBatch(tx, branch.branch_id, cursor),
          { sqliteImmediate: true }
        );
        for (const [, query] of queries.mock.calls) {
          expect(new PgDialect().sqlToQuery(query).params.length).toBeLessThanOrEqual(753);
        }
      } finally {
        queries.mockRestore();
      }
      // Resume only from the serialized keyset cursor, with no process-local state.
      cursor = JSON.parse(JSON.stringify(result.cursor));
      if (result.done || onePage) break;
    }
  };

  for (const count of [1000, 1001]) {
    await sessions.update(parent.session_id, { genealogy: { children: children.slice(0, count) } });
    // Parent is the first surviving row. The mixed case below walks every
    // keyset page; boundary cases need not re-scan 1001 unrelated child rows.
    await scan(0, true);
    expect((await sessions.findById(parent.session_id))?.genealogy.children).toEqual(
      children.slice(0, count)
    );
  }

  // Relevant IDs on both sides of query chunk boundaries and the former limit.
  const mixed = [...children];
  const ownedIds = new Set([owned.session_id]);
  for (const index of [0, 249, 250, 999, 1000]) {
    const extra = await sessions.create({ branch_id: branch.branch_id, created_by: user.user_id });
    ownedIds.add(extra.session_id);
    mixed.splice(index, 0, extra.session_id);
  }
  await sessions.update(parent.session_id, {
    genealogy: { children: mixed },
    callback_config: { enabled: true, callback_session_id: owned.session_id },
  });
  // These rows straddle the early row-boundary yield after the wide parent.
  // Advancing to the last *fetched*, rather than processed, row would miss them.
  for (const index of [20, 24]) {
    await sessions.update(children[index]!, {
      callback_config: { enabled: true, callback_session_id: owned.session_id },
    });
  }
  const task = await tasks.create({ session_id: parent.session_id, created_by: user.user_id });
  const namespaceRows = Array.from({ length: 1001 }, (_, i) => ({
    namespace_id: generateId(),
    slug: `surviving-${i}`,
    display_name: `Surviving ${i}`,
    kind: 'branch' as const,
    branch_id: survivor.branch_id,
    created_at: new Date(),
  }));
  // Real namespace rows, in bounded fixture-only inserts. Admission itself is
  // covered by branch-deletion-data / branch-maintenance tests, not 1001
  // redundant acquisitions of the same branch lock in this scanner fixture.
  await runDatabaseTransaction(
    db,
    async (tx) => {
      for (let offset = 0; offset < namespaceRows.length; offset += 25) {
        await insert(tx, kbNamespaces)
          .values(namespaceRows.slice(offset, offset + 25))
          .run();
      }
    },
    { sqliteImmediate: true }
  );
  const grants: TeammateKnowledgeGrant[] = namespaceRows.map(({ namespace_id, slug }) => ({
    namespace_id,
    namespace_slug: slug,
    access: 'read',
  }));
  const arbitrary = {
    children: mixed,
    branch_id: branch.branch_id,
    nested: { target_session_id: owned.session_id },
  };
  // Seed schema-owned metadata plus arbitrary sibling JSON without service normalization.
  const taskData = {
    metadata: {
      completion_callback: {
        target_session_id: owned.session_id,
        requested_from_session_id: parent.session_id,
        requested_by_user_id: user.user_id,
      },
      callback_dispatches: mixed.map((id, i) => ({
        event: 'task_completion',
        dispatched_at: task.created_at,
        target_session_id: id,
        queued_task_id: i === 1002 ? ownedTask.task_id : undefined,
      })),
      children: mixed,
      user_payload: arbitrary,
    },
    full_prompt: JSON.stringify(arbitrary),
  };
  const writeData = async (table: string, key: string, id: string, data: unknown) => {
    const encoded = JSON.stringify(data);
    await executeRaw(
      db,
      sql`UPDATE ${sql.identifier(table)} SET data = ${isPostgresDatabase(db) ? sql`${encoded}::jsonb` : sql`${encoded}`} WHERE ${sql.identifier(key)} = ${id}`
    );
  };
  const readData = async (table: string, key: string, id: string) => {
    const row = rawRows(
      await executeRaw(
        db,
        sql`SELECT data FROM ${sql.identifier(table)} WHERE ${sql.identifier(key)} = ${id}`
      )
    )[0]!;
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  };
  await writeData('tasks', 'task_id', task.task_id, taskData);
  const branchData = await readData('branches', 'branch_id', survivor.branch_id);
  const mixedGrants = [...grants];
  for (const index of [249, 250, 1000, 1001])
    mixedGrants.splice(index, 0, {
      namespace_id: ownedNamespace.namespace_id,
      namespace_slug: ownedNamespace.slug,
      access: 'read',
    });
  branchData.custom_context = {
    teammate: { kb: { grants: mixedGrants }, user_payload: arbitrary },
    assistant: { kb: { grants: mixedGrants } },
    agent: { kb: { grants: mixedGrants } },
    user_payload: arbitrary,
  };
  await writeData('branches', 'branch_id', survivor.branch_id, branchData);
  await scan();
  const updated = await sessions.findById(parent.session_id);
  expect(updated?.genealogy.children).toEqual(children);
  expect(updated?.callback_config).toMatchObject({ enabled: false });
  expect(updated?.callback_config?.callback_session_id).toBeUndefined();
  for (const index of [20, 24]) {
    expect(
      (await sessions.findById(children[index]!))?.callback_config?.callback_session_id
    ).toBeUndefined();
  }
  const cleanedTask = await readData('tasks', 'task_id', task.task_id);
  expect(cleanedTask).toEqual({
    ...taskData,
    metadata: {
      children,
      callback_dispatches: taskData.metadata.callback_dispatches
        .filter(
          (entry) =>
            !ownedIds.has(entry.target_session_id) && entry.queued_task_id !== ownedTask.task_id
        )
        .map((entry) => ({
          event: entry.event,
          dispatched_at: entry.dispatched_at,
          target_session_id: entry.target_session_id,
        })),
      user_payload: arbitrary,
    },
  });
  const cleanedBranch = await readData('branches', 'branch_id', survivor.branch_id);
  expect(cleanedBranch.custom_context).toEqual({
    teammate: { kb: { grants }, user_payload: arbitrary },
    assistant: { kb: { grants } },
    agent: { kb: { grants } },
    user_payload: arbitrary,
  });
  // A later pass reads the latest (shrunk/reordered) arrays, not stale offsets.
  await sessions.update(parent.session_id, {
    genealogy: { children: [children[1000]!, owned.session_id, children[0]!] },
    title: 'concurrent field retained',
  });
  await scan(0, true);
  expect((await sessions.findById(parent.session_id))?.genealogy.children).toEqual([
    children[1000],
    children[0],
  ]);
  expect((await sessions.findById(parent.session_id))?.title).toBe('concurrent field retained');
  // Cleaned wide task/grant arrays are all unrelated and remain byte-for-byte
  // stable on another pass, without walking the session table again.
  await scan(1);
  expect(await readData('tasks', 'task_id', task.task_id)).toEqual(cleanedTask);
  expect(await readData('branches', 'branch_id', survivor.branch_id)).toEqual(cleanedBranch);
  // A blocker beyond large grants is still inspected, never skipped/truncated.
  cleanedBranch.custom_context.agent.kb.primary_namespace_id = ownedNamespace.namespace_id;
  await writeData('branches', 'branch_id', survivor.branch_id, cleanedBranch);
  await expect(scan(4)).rejects.toThrow('surviving teammate');
  expect((await new BranchRepository(db).findById(branch.branch_id))?.branch_id).toBe(
    branch.branch_id
  );
  return { branch, survivor, parent, children, task, owned };
}
