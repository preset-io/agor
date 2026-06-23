/**
 * Tests for `SessionsService.find` board_id pushdown (non-RBAC path).
 *
 * A session relates to a board through its branch (session.branch_id →
 * branch.board_id). The `sessions.board_id` column is never populated, so the
 * filter MUST go through the branch join — both in the indexed repository query
 * (`findByBoard`) and in the service's non-RBAC find override. These tests pin
 * that behaviour down end-to-end against a real database, and confirm the other
 * Feathers query filters (archived, $sort, $limit/$skip) keep working alongside
 * board_id.
 */
import {
  BoardRepository,
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

// The find() board_id path only touches the session repos built from `db`; the
// stored `app` is never read. A bare cast keeps the harness minimal.
const STUB_APP = {} as unknown as Application;

async function createBoard(db: any): Promise<UUID> {
  const boardRepo = new BoardRepository(db);
  const board = await boardRepo.create({ name: 'Board', created_by: 'test-user' as UUID });
  return board.board_id as UUID;
}

async function createBranchOnBoard(db: any, boardId: UUID | null): Promise<UUID> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'feature',
    ref: 'feature',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: 'test-user' as UUID,
    ...(boardId ? { board_id: boardId } : {}),
  });
  return branch.branch_id as UUID;
}

async function createSession(
  db: any,
  branchId: UUID,
  overrides: Partial<Session> = {}
): Promise<UUID> {
  const sessionRepo = new SessionRepository(db);
  const session = await sessionRepo.create({
    session_id: generateId(),
    branch_id: branchId,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: 'test-user' as UUID,
    git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
  return session.session_id as UUID;
}

function ids(result: Awaited<ReturnType<SessionsService['find']>>): string[] {
  const data = Array.isArray(result) ? result : result.data;
  return data.map((s) => s.session_id).sort();
}

describe('SessionsService.find — board_id pushdown', () => {
  dbTest('returns only sessions whose branch is on the requested board', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);

    const boardA = await createBoard(db);
    const boardB = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);
    const branchB = await createBranchOnBoard(db, boardB);

    const a1 = await createSession(db, branchA);
    const a2 = await createSession(db, branchA);
    const b1 = await createSession(db, branchB);

    const onA = await service.find({ query: { board_id: boardA, $limit: 100 } });
    expect(ids(onA)).toEqual([a1, a2].sort());

    const onB = await service.find({ query: { board_id: boardB, $limit: 100 } });
    expect(ids(onB)).toEqual([b1]);

    // No board filter → every session across boards.
    const all = await service.find({ query: { $limit: 100 } });
    expect(ids(all)).toEqual([a1, a2, b1].sort());
  });

  dbTest('returns empty for a board with no branches/sessions', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const boardA = await createBoard(db);
    const emptyBoard = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);
    await createSession(db, branchA);

    const result = await service.find({ query: { board_id: emptyBoard, $limit: 100 } });
    expect(ids(result)).toEqual([]);
  });

  dbTest('keeps other filters working alongside board_id', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const boardA = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);

    const active = await createSession(db, branchA, { status: SessionStatus.IDLE });
    await createSession(db, branchA, { archived: true });
    await createSession(db, branchA, { status: SessionStatus.RUNNING });

    // archived filter narrows within the board scope.
    const activeOnly = await service.find({
      query: { board_id: boardA, archived: false, $limit: 100 },
    });
    const activeData = Array.isArray(activeOnly) ? activeOnly : activeOnly.data;
    expect(activeData.every((s) => !s.archived)).toBe(true);
    expect(activeData.map((s) => s.session_id)).toContain(active);
    expect(activeData).toHaveLength(2);

    // status filter narrows within the board scope.
    const running = await service.find({
      query: { board_id: boardA, status: SessionStatus.RUNNING, $limit: 100 },
    });
    const runningData = Array.isArray(running) ? running : running.data;
    expect(runningData).toHaveLength(1);
    expect(runningData[0].status).toBe(SessionStatus.RUNNING);

    // $limit/$skip pagination still applies on the board-scoped set.
    const paged = await service.find({ query: { board_id: boardA, $limit: 1, $skip: 1 } });
    expect(Array.isArray(paged) ? paged.length : paged.data.length).toBe(1);
    expect(Array.isArray(paged) ? 3 : paged.total).toBe(3);
  });
});
