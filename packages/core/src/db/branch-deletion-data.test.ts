import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { generateId } from '../lib/ids';
import { BRANCH_DELETION_BATCH_SIZE, deleteBranchDataBatch } from './branch-deletion-data';
import {
  reconcileBranchDeletionReferencesBatch,
  scrubBranchDeletionReferences,
} from './branch-deletion-references';
import { executeRaw, insert, runDatabaseTransaction, select } from './database-wrapper';
import { BranchMaintenanceRepository } from './repositories/branch-maintenance';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { SessionRepository } from './repositories/sessions';
import { TaskRepository } from './repositories/tasks';
import { branches, messages } from './schema';
import { ownedDbTest as test } from './test-helpers';

test('drains a large single session in bounded transactions, preserves shared neighbors and keeps branch last', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const { branch: neighbor } = await seedEnvironmentCommandBranch(db);
  await new BranchRepository(db).update(neighbor.branch_id, { path: '/tmp/neighbor-fixture' });
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    created_by: user.user_id,
    agentic_tool: 'codex',
  });
  const foreign = await new SessionRepository(db).create({
    branch_id: neighbor.branch_id,
    created_by: neighbor.created_by,
    agentic_tool: 'codex',
  });
  const task = await new TaskRepository(db).create({
    session_id: session.session_id,
    created_by: user.user_id,
    status: 'completed',
  });
  for (let i = 0; i < BRANCH_DELETION_BATCH_SIZE + 7; i++) {
    await insert(db, messages)
      .values({
        message_id: generateId(),
        session_id: session.session_id,
        task_id: task.task_id,
        created_at: new Date(),
        timestamp: new Date(),
        type: 'assistant',
        role: 'assistant',
        index: i,
        data: { content: 'fixture' },
      })
      .run();
  }
  const foreignMessage = generateId();
  await insert(db, messages)
    .values({
      message_id: foreignMessage,
      session_id: foreign.session_id,
      task_id: task.task_id,
      created_at: new Date(),
      timestamp: new Date(),
      type: 'assistant',
      role: 'assistant',
      index: 0,
      data: { content: 'neighbor' },
    })
    .run();
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  const execution = await maintenance.beginExecution(claim);
  await maintenance.claimExecution(claim, execution);
  const counts: number[] = [];
  for (let attempts = 0; ; attempts++) {
    expect(attempts).toBeLessThan(30);
    const result = await maintenance.withExecution(claim, execution, (tx) =>
      deleteBranchDataBatch(tx, branch.branch_id, 'fixture-command')
    );
    expect(result.changed).toBeLessThanOrEqual(BRANCH_DELETION_BATCH_SIZE);
    if (result.table === 'messages') counts.push(result.changed);
    if (!result.remaining) break;
  }
  expect(counts).toContain(BRANCH_DELETION_BATCH_SIZE);
  expect(await new BranchRepository(db).findById(branch.branch_id)).not.toBeNull();
  expect(await new SessionRepository(db).findById(session.session_id)).toBeNull();
  expect(await new SessionRepository(db).findById(foreign.session_id)).not.toBeNull();
  expect(
    (await select(db).from(messages).where(eq(messages.message_id, foreignMessage)).one())?.task_id
  ).toBeNull();
  expect(await new BranchRepository(db).findById(neighbor.branch_id)).not.toBeNull();
});

test('reference reconciliation clears exact structured pointers but leaves arbitrary content unchanged', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const { branch: neighbor } = await seedEnvironmentCommandBranch(db);
  await new BranchRepository(db).update(neighbor.branch_id, { path: '/tmp/neighbor-fixture' });
  await executeRaw(
    db,
    sql`UPDATE branches SET data = json_set(data, '$.custom_context.fixture.branch_id', ${branch.branch_id}, '$.custom_context.fixture.text', ${branch.branch_id}) WHERE branch_id = ${neighbor.branch_id}`
  );
  let cursor = { table: 0 };
  for (let n = 0; ; n++) {
    expect(n).toBeLessThan(30);
    const next = await runDatabaseTransaction(
      db,
      (tx) => reconcileBranchDeletionReferencesBatch(tx, branch.branch_id, cursor),
      { sqliteImmediate: true }
    );
    cursor = next.cursor;
    if (next.done) break;
  }
  const row = await select(db)
    .from(branches)
    .where(eq(branches.branch_id, neighbor.branch_id))
    .one();
  expect(row?.data.custom_context).toMatchObject({ fixture: { text: branch.branch_id } });
  expect(row?.data.custom_context).toMatchObject({ fixture: { branch_id: branch.branch_id } });
  expect(
    scrubBranchDeletionReferences(
      { text: branch.branch_id, metadata: { child_session_id: branch.branch_id } },
      new Set([branch.branch_id])
    )
  ).toEqual({ text: branch.branch_id, metadata: {} });
  expect(() =>
    scrubBranchDeletionReferences(
      { primary_namespace_id: branch.branch_id },
      new Set([branch.branch_id])
    )
  ).toThrow('surviving teammate');
});

test('completed reference scan fences late teammate dependencies and namespace ownership changes', async ({
  db,
}) => {
  const { KnowledgeNamespaceRepository } = await import('./repositories/knowledge');
  const { BranchDeletionRepository } = await import('./repositories/branch-deletion');
  const { branch } = await seedEnvironmentCommandBranch(db);
  const { branch: neighbor } = await seedEnvironmentCommandBranch(db);
  const branches = new BranchRepository(db);
  await branches.update(neighbor.branch_id, { path: '/tmp/late-reference-neighbor' });
  const namespaces = new KnowledgeNamespaceRepository(db);
  const namespace = await namespaces.create({
    slug: 'deleting-owner',
    kind: 'branch',
    branch_id: branch.branch_id,
  });
  const shared = await namespaces.create({ slug: 'shared-owner', kind: 'global' });
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  const invocation = await maintenance.beginExecution(claim);
  await maintenance.claimExecution(claim, invocation);
  const deletion = new BranchDeletionRepository(db);
  for (let page = 0; ; page++) {
    expect(page).toBeLessThan(30);
    if (!(await deletion.quiescePage(claim, invocation)).remaining) break;
  }
  const custom_context = {
    teammate: { kind: 'teammate', kb: { primary_namespace_id: namespace.namespace_id } },
  };
  await expect(branches.update(neighbor.branch_id, { custom_context })).rejects.toThrow('deletion');
  await expect(
    branches.create({
      ...neighbor,
      branch_id: generateId(),
      name: 'late',
      branch_unique_id: 9876,
      path: '/tmp/late',
      custom_context,
    })
  ).rejects.toThrow('deletion');
  await expect(
    namespaces.update(namespace.namespace_id, { kind: 'global', branch_id: null })
  ).rejects.toThrow('deletion');
  await expect(
    namespaces.update(shared.namespace_id, { kind: 'branch', branch_id: branch.branch_id })
  ).rejects.toThrow('deletion');
  expect((await namespaces.findById(namespace.namespace_id))?.branch_id).toBe(branch.branch_id);
  expect((await namespaces.findById(shared.namespace_id))?.branch_id).toBeNull();
  await branches.update(neighbor.branch_id, {
    custom_context: {
      teammate: { kind: 'teammate', kb: { primary_namespace_id: shared.namespace_id } },
    },
  });
});
