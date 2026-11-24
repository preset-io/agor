/**
 * PostgreSQL-gated check that leaderboard usage undoes session running totals
 * (window and fork baseline) on PostgreSQL, inside one tenant's scope.
 */

import {
  BranchRepository,
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { AgenticToolName, SessionID, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { LeaderboardService } from './leaderboard.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const describePostgres =
  postgresUrl && process.env.AGOR_DB_DIALECT === 'postgresql' ? describe : describe.skip;

async function seedBranch(scoped: TenantScopeAwareDatabase) {
  const owner = await new UsersRepository(scoped).create({
    email: `leaderboard-${generateId()}@example.invalid`,
    role: 'member',
  });
  const repo = await new RepoRepository(scoped).create({
    slug: `leaderboard-${generateId()}`,
    name: 'Leaderboard',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/leaderboard.git',
    local_path: `/tmp/leaderboard-${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(scoped).create({
    repo_id: repo.repo_id,
    name: 'leaderboard',
    path: `/tmp/leaderboard-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    created_by: owner.user_id as UUID,
  });
  return { ownerId: owner.user_id as UUID, branchId: branch.branch_id };
}

async function seedSession(
  scoped: TenantScopeAwareDatabase,
  base: { ownerId: UUID; branchId: string },
  tool: AgenticToolName,
  forkedFrom?: SessionID
): Promise<SessionID> {
  const session = await new SessionRepository(scoped).create({
    branch_id: base.branchId as never,
    agentic_tool: tool,
    created_by: base.ownerId,
    ...(forkedFrom ? { genealogy: { forked_from_session_id: forkedFrom, children: [] } } : {}),
  });
  return session.session_id;
}

async function seedTasks(
  scoped: TenantScopeAwareDatabase,
  sessionId: SessionID,
  ownerId: UUID,
  rows: Array<{ hour: number; costUsd: number; inputTokens?: number; outputTokens?: number }>
): Promise<void> {
  const tasks = new TaskRepository(scoped);
  for (const row of rows) {
    const task = await tasks.create({
      session_id: sessionId,
      created_by: ownerId,
      status: TaskStatus.COMPLETED,
      normalized_sdk_response: {
        tokenUsage: {
          inputTokens: row.inputTokens ?? 0,
          outputTokens: row.outputTokens ?? 0,
          totalTokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
        },
        costUsd: row.costUsd,
      },
    });
    const at = new Date(Date.UTC(2026, 0, 1, row.hour)).toISOString();
    await tasks.update(task.task_id, { started_at: at, completed_at: at });
  }
}

describePostgres('LeaderboardService session-cumulative usage on PostgreSQL', () => {
  let db: Database;
  beforeAll(async () => {
    db = createDatabase({ url: postgresUrl!, dialect: 'postgresql' });
    await initializeDatabase(db);
  });

  it('keeps the fork baseline when the first task has no usage', async () => {
    await runWithTenantDatabaseScope(db, `leaderboard-${generateId()}`, async (scoped) => {
      const base = await seedBranch(scoped);
      const parent = await seedSession(scoped, base, 'claude-code');
      await seedTasks(scoped, parent, base.ownerId, [{ hour: 0, costUsd: 2 }]);
      const fork = await seedSession(scoped, base, 'claude-code', parent);
      const repository = new TaskRepository(scoped);
      const first = await repository.create({
        session_id: fork,
        created_by: base.ownerId,
        status: TaskStatus.COMPLETED,
      });
      const at = '2026-01-01T01:00:00.000Z';
      await repository.update(first.task_id, { started_at: at, completed_at: at });
      await seedTasks(scoped, parent, base.ownerId, [{ hour: 2, costUsd: 4 }]);
      await seedTasks(scoped, fork, base.ownerId, [
        { hour: 3, costUsd: 2.5 },
        { hour: 4, costUsd: 3 },
      ]);
      const { data } = await new LeaderboardService(scoped).find({ query: { groupBy: 'tool' } });
      expect.soft(data[0]?.totalCost).toBeCloseTo(5, 6);
      expect.soft((await repository.getSessionUsage(fork)).cost).toBeCloseTo(1, 6);
    });
  });

  it('counts running totals once, forks from the parent baseline, per tenant', async () => {
    const tenantA = `leaderboard-a-${generateId()}`;
    const tenantB = `leaderboard-b-${generateId()}`;
    let forkId: SessionID | undefined;

    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const base = await seedBranch(scoped);
      const parent = await seedSession(scoped, base, 'claude-code');
      await seedTasks(scoped, parent, base.ownerId, [
        { hour: 0, costUsd: 1 },
        { hour: 1, costUsd: 2 },
      ]);
      forkId = await seedSession(scoped, base, 'claude-code', parent);
      await seedTasks(scoped, forkId, base.ownerId, [
        { hour: 2, costUsd: 2.5 },
        { hour: 3, costUsd: 3 },
      ]);
      const codex = await seedSession(scoped, base, 'codex');
      await seedTasks(scoped, codex, base.ownerId, [
        { hour: 0, costUsd: 1, inputTokens: 100, outputTokens: 10 },
        { hour: 1, costUsd: 2, inputTokens: 250, outputTokens: 30 },
      ]);
      const gemini = await seedSession(scoped, base, 'gemini');
      await seedTasks(scoped, gemini, base.ownerId, [
        { hour: 0, costUsd: 1, inputTokens: 100, outputTokens: 10 },
        { hour: 1, costUsd: 2, inputTokens: 250, outputTokens: 30 },
      ]);

      const { data } = await new LeaderboardService(scoped).find({ query: { groupBy: 'tool' } });
      const byTool = Object.fromEntries(data.map((row) => [row.tool, row]));
      // Parent 2, fork 1 on top of the parent's 2.
      expect(byTool['claude-code']?.totalCost).toBeCloseTo(3, 6);
      expect(byTool['claude-code']?.taskCount).toBe(4);
      expect(byTool.codex?.totalCost).toBeCloseTo(2, 6);
      expect(byTool.codex?.totalInputTokens).toBe(250);
      expect(byTool.codex?.totalOutputTokens).toBe(30);
      expect(byTool.gemini?.totalCost).toBeCloseTo(3, 6);
      expect(byTool.gemini?.totalInputTokens).toBe(350);

      expect((await new TaskRepository(scoped).getSessionUsage(forkId)).cost).toBeCloseTo(1, 6);
    });

    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      const base = await seedBranch(scoped);
      const session = await seedSession(scoped, base, 'claude-code');
      await seedTasks(scoped, session, base.ownerId, [
        { hour: 0, costUsd: 1 },
        { hour: 1, costUsd: 2 },
        { hour: 2, costUsd: 3 },
      ]);

      const { data } = await new LeaderboardService(scoped).find({ query: { groupBy: 'tool' } });
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ tool: 'claude-code', taskCount: 3, sessionCount: 1 });
      expect(data[0]?.totalCost).toBeCloseTo(3, 6);
      // Tenant A's fork is not visible here.
      expect((await new TaskRepository(scoped).getSessionUsage(forkId!)).cost).toBe(0);
    });
  });
});
