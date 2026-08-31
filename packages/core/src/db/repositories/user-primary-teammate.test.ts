import type { Board, BranchID, UUID } from '@agor/core/types';
import { afterEach, describe, expect } from 'vitest';
import type { AnalyticsLogger, AnalyticsProperties, AnalyticsTrackOptions } from '../../analytics';
import { resetAnalyticsLoggerForTests, setAnalyticsLoggerForTests } from '../../analytics';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { ownedDbTest as dbTest, setTestBranchUserRole } from '../test-helpers';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import {
  USER_PRIMARY_TEAMMATE_SET_EVENT,
  UserPrimaryTeammateRepository,
} from './user-primary-teammate';
import { UsersRepository } from './users';

interface CapturedEvent {
  event: string;
  properties?: AnalyticsProperties;
  options?: AnalyticsTrackOptions;
}

function createCapturingLogger(sink: CapturedEvent[]): AnalyticsLogger {
  return {
    isEnabled: () => true,
    track: (event, properties, options) => {
      sink.push({ event, properties, options });
    },
  };
}

let branchUniqueId = 5_000;

async function createUser(db: Database, email: string): Promise<UUID> {
  const user = await new UsersRepository(db).create({ email, role: 'member' });
  return user.user_id as UUID;
}

async function createBoard(db: Database, overrides?: Partial<Board>): Promise<Board> {
  return new BoardRepository(db).create({
    board_id: generateId(),
    name: overrides?.name ?? 'Board',
    created_by: overrides?.created_by ?? 'test-user',
    access_mode: overrides?.access_mode ?? 'shared',
  });
}

async function createBranch(
  db: Database,
  boardId: UUID,
  overrides?: { permission_source?: 'board' | 'override'; others_can?: 'none' | 'session' }
): Promise<BranchID> {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `repo-${branchUniqueId}`,
    name: `repo-${branchUniqueId}`,
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/home/user/.agor/repos/repo-${branchUniqueId}`,
    default_branch: 'main',
  });
  const name = `teammate-${branchUniqueId}`;
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name,
    ref: name,
    branch_unique_id: branchUniqueId++,
    path: `/tmp/${name}`,
    board_id: boardId,
    created_by: 'test-user' as UUID,
    permission_source: overrides?.permission_source ?? 'override',
    others_can: overrides?.others_can ?? 'session',
    custom_context: { teammate: { kind: 'teammate', displayName: name } },
  });
  return branch.branch_id as BranchID;
}

describe('UserPrimaryTeammateRepository', () => {
  afterEach(() => {
    resetAnalyticsLoggerForTests();
  });

  dbTest('resolves a board-level teammate on an accessible board', async ({ db }) => {
    const repo = new UserPrimaryTeammateRepository(db);
    const user = await createUser(db, 'board-level@example.com');
    const board = await createBoard(db, { access_mode: 'shared' });
    const branchId = await createBranch(db, board.board_id as UUID, {
      permission_source: 'board',
    });

    await repo.setPrimaryTeammate(user, branchId, { source: 'default' });

    const resolved = await repo.resolvePrimaryTeammate(user);
    expect(resolved?.branch_id).toBe(branchId);
  });

  dbTest(
    'resolves a teammate embedded on another (private) board via direct ownership',
    async ({ db }) => {
      const repo = new UserPrimaryTeammateRepository(db);
      const user = await createUser(db, 'cross-board@example.com');

      // Teammate lives on a private board the user does not own; only direct
      // branch ownership grants access — the cross-board case boards support.
      const otherBoard = await createBoard(db, { access_mode: 'private' });
      const branchId = await createBranch(db, otherBoard.board_id as UUID, {
        permission_source: 'override',
        others_can: 'none',
      });
      await setTestBranchUserRole(db, branchId, user, 'manager');

      await repo.setPrimaryTeammate(user, branchId, { source: 'default' });

      const resolved = await repo.resolvePrimaryTeammate(user);
      expect(resolved?.branch_id).toBe(branchId);
    }
  );

  dbTest('returns null when the user has lost access to the stored branch', async ({ db }) => {
    const repo = new UserPrimaryTeammateRepository(db);
    const user = await createUser(db, 'lost-access@example.com');
    const privateBoard = await createBoard(db, { access_mode: 'private' });
    const branchId = await createBranch(db, privateBoard.board_id as UUID, {
      permission_source: 'override',
      others_can: 'none',
    });

    // Stored, but the user is not an owner and the branch is private → no access.
    await repo.setPrimaryTeammate(user, branchId, { source: 'default' });

    expect(await repo.getBranchId(user)).toBe(branchId);
    expect(await repo.resolvePrimaryTeammate(user)).toBeNull();
  });

  dbTest('returns null when no primary teammate is set', async ({ db }) => {
    const repo = new UserPrimaryTeammateRepository(db);
    const user = await createUser(db, 'unset@example.com');
    expect(await repo.resolvePrimaryTeammate(user)).toBeNull();
  });

  dbTest('setPrimaryTeammateIfUnset preserves an existing explicit selection', async ({ db }) => {
    const repo = new UserPrimaryTeammateRepository(db);
    const user = await createUser(db, 'conditional@example.com');
    const board = await createBoard(db, { access_mode: 'shared' });
    const explicit = await createBranch(db, board.board_id as UUID);
    const fallback = await createBranch(db, board.board_id as UUID);

    await repo.setPrimaryTeammate(user, explicit, { source: 'explicit' });
    await expect(
      repo.setPrimaryTeammateIfUnset(user, fallback, { source: 'default' })
    ).resolves.toBe(false);
    expect(await repo.getBranchId(user)).toBe(explicit);
  });

  dbTest('stores the teammate on User without replacing sibling preferences', async ({ db }) => {
    const users = new UsersRepository(db);
    const user = await users.create({
      email: 'user-attribute@example.com',
      role: 'member',
      primary_agentic_tool: 'codex',
    });
    const board = await createBoard(db, { access_mode: 'shared' });
    const branchId = await createBranch(db, board.board_id as UUID);
    const repo = new UserPrimaryTeammateRepository(db);

    await repo.setPrimaryTeammate(user.user_id, branchId, { source: 'explicit' });
    await expect(users.findById(user.user_id)).resolves.toMatchObject({
      primary_agentic_tool: 'codex',
      primary_teammate_id: branchId,
    });

    await repo.clearPrimaryTeammate(user.user_id);
    await expect(users.findById(user.user_id)).resolves.toMatchObject({
      primary_agentic_tool: 'codex',
      primary_teammate_id: undefined,
    });
  });

  dbTest('emits an assignment event carrying the source', async ({ db }) => {
    const events: CapturedEvent[] = [];
    setAnalyticsLoggerForTests(createCapturingLogger(events));

    const repo = new UserPrimaryTeammateRepository(db);
    const user = await createUser(db, 'event@example.com');
    const board = await createBoard(db, { access_mode: 'shared' });
    const branchId = await createBranch(db, board.board_id as UUID, {
      permission_source: 'board',
    });

    await repo.setPrimaryTeammate(user, branchId, { source: 'default' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: USER_PRIMARY_TEAMMATE_SET_EVENT,
      properties: { user_id: user, branch_id: branchId, source: 'default' },
      options: { userId: user },
    });
  });
});
