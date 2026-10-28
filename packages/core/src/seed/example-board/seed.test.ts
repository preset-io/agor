import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { select } from '../../db/database-wrapper';
import { notExampleBoardOwned } from '../../db/example-board';
import {
  ArtifactRepository,
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  GatewayChannelRepository,
  MessagesRepository,
  ScheduleRepository,
  SessionRepository,
  TaskRepository,
  UserPrimaryTeammateRepository,
  UsersRepository,
} from '../../db/repositories';
import { sanitizeImportedBoardObjects } from '../../db/repositories/boards';
import { tasks, users } from '../../db/schema';
import { dbTest } from '../../db/test-helpers';
import {
  type BranchID,
  EXAMPLE_BOARD_OWNER_EMAIL,
  getGatewaySource,
  isTeammate,
  type UserID,
  type UUID,
} from '../../types';
import { EXAMPLE_BOARD_FIXTURE } from './fixture';
import { seedExampleBoard } from './seed';

const fixture = EXAMPLE_BOARD_FIXTURE;

describe('example board fixture', () => {
  it('uses only board object kinds and shapes import accepts', () => {
    const { skipped } = sanitizeImportedBoardObjects(fixture.board.objects ?? {});
    expect(skipped).toEqual([]);
  });

  it('references only zones, branches, sessions and schedules it defines', () => {
    const zones = new Set(
      Object.entries(fixture.board.objects ?? {})
        .filter(([, object]) => object.type === 'zone')
        .map(([id]) => id)
    );
    const branches = new Set(fixture.branches.map((b) => b.key));
    const sessions = new Set(fixture.sessions.map((s) => s.key));
    const schedules = new Set(fixture.schedules.map((s) => s.key));

    for (const placed of [...fixture.branches, ...fixture.cards]) {
      expect(zones).toContain(placed.zone);
    }
    for (const session of fixture.sessions) {
      expect(branches).toContain(session.branch);
      for (const parent of [session.spawnedFrom, session.forkedFrom]) {
        if (parent) expect(sessions).toContain(parent);
      }
      if (session.schedule) expect(schedules).toContain(session.schedule);
      expect('user' in session.turns[0]).toBe(true);
    }
    for (const artifact of fixture.artifacts) {
      expect(branches).toContain(artifact.branch);
      expect(sessions).toContain(artifact.session);
    }
  });

  it('covers what the example promises: one teammate, Slack, spawn tree and a fork', () => {
    expect(fixture.branches.filter((b) => b.teammate)).toHaveLength(1);
    expect(fixture.sessions.some((s) => s.gateway?.channel_type === 'slack')).toBe(true);
    const spawnParents = fixture.sessions.map((s) => s.spawnedFrom).filter(Boolean);
    expect(new Set(spawnParents).size).toBe(1);
    expect(spawnParents).toHaveLength(3);
    expect(fixture.sessions.some((s) => s.forkedFrom)).toBe(true);
  });
});

describe('seedExampleBoard', () => {
  dbTest('seeds the fixture once, owned by a non-loginable system user', async ({ db }) => {
    const first = await seedExampleBoard(db);
    const second = await seedExampleBoard(db);

    expect(first.seeded).toBe(true);
    expect(second).toEqual({ seeded: false });

    const owner = await new UsersRepository(db).findByEmail(EXAMPLE_BOARD_OWNER_EMAIL);
    expect(owner?.role).toBe('viewer');
    const credential = await select(db, { password: users.password })
      .from(users)
      .where(eq(users.email, EXAMPLE_BOARD_OWNER_EMAIL))
      .one();
    expect(credential?.password).toBe('');

    const boards = await new BoardRepository(db).findAll();
    expect(boards).toHaveLength(1);
    expect(boards[0].created_by).toBe(owner?.user_id);
    expect(boards[0].primary_teammate_id).toBeUndefined();

    const branches = await new BranchRepository(db).findAll();
    expect(branches).toHaveLength(fixture.branches.length);
    expect(branches.filter((b) => isTeammate(b))).toHaveLength(1);
    expect(branches.every((b) => b.created_by === owner?.user_id)).toBe(true);

    const sessions = await new SessionRepository(db).findAll();
    expect(sessions).toHaveLength(fixture.sessions.length);
    expect(sessions.every((s) => s.status === 'completed')).toBe(true);
    expect(sessions.filter((s) => getGatewaySource(s)?.channel_type === 'slack')).toHaveLength(
      fixture.sessions.filter((s) => s.gateway).length
    );
    const competitors = sessions.find((s) => s.title === 'Competitor changes this week');
    expect(competitors?.genealogy.children).toHaveLength(3);
    expect(sessions.find((s) => s.genealogy.forked_from_session_id)?.title).toBe(
      'Darker hero variant'
    );

    expect(await new TaskRepository(db).findAll()).toHaveLength(fixture.sessions.length);
    const messages = await new MessagesRepository(db).findBySessionId(competitors!.session_id);
    const prompt = fixture.sessions.find((s) => s.key === 'competitors')!.turns[0];
    expect(messages[0].content).toBe((prompt as { user: string }).user);

    const schedules = await new ScheduleRepository(db).findAll();
    expect(schedules).toHaveLength(fixture.schedules.length);
    expect(schedules.every((s) => !s.enabled)).toBe(true);

    const placements = await new BoardObjectRepository(db).findByBoardId(boards[0].board_id);
    expect(placements).toHaveLength(fixture.branches.length + fixture.cards.length);
    expect(await new ArtifactRepository(db).findAll()).toHaveLength(fixture.artifacts.length);
    const artifactObjects = Object.values(boards[0].objects ?? {}).filter(
      (o) => o.type === 'artifact'
    );
    expect(artifactObjects).toHaveLength(fixture.artifacts.length);
  });

  dbTest('is read-only for other members', async ({ db }) => {
    const result = await seedExampleBoard(db);
    const member = await new UsersRepository(db).create({
      email: 'member@example.test',
      role: 'member',
    });
    const memberId = member.user_id as UserID;
    const policies = new CapabilityPolicyRepository(db);

    const board = await policies.resolveBoardAccess(result.board_id!, memberId);
    expect(board.capabilities).toEqual(['board.view']);

    for (const branch of await new BranchRepository(db).findAll()) {
      const access = await policies.resolveBranchAccess(branch.branch_id as BranchID, memberId);
      expect(access.capabilities).toEqual(['branch.view']);
      expect(access.fs_access).toBe('none');
    }
    const [session] = await new SessionRepository(db).findAll();
    const authority = await policies.resolveSessionPromptAuthority({
      branch_id: session.branch_id as BranchID,
      caller_user_id: memberId,
      session_owner_user_id: session.created_by as UserID,
      session_sdk_home_scope: 'branch',
    });
    expect(authority.allowed).toBe(false);
  });
});

describe('example board exclusions', () => {
  dbTest('is never a primary teammate candidate, even without access checks', async ({ db }) => {
    await seedExampleBoard(db);
    const member = await new UsersRepository(db).create({ email: 'm@example.test' });
    const teammates = new UserPrimaryTeammateRepository(db);
    const wendy = (await new BranchRepository(db).findAll()).find((b) => isTeammate(b))!;

    expect(
      await teammates.findEligiblePrimaryTeammates(member.user_id as UserID, {
        enforceAccess: false,
      })
    ).toEqual([]);
    expect(
      await teammates.findEligiblePrimaryTeammate(
        wendy.branch_id as BranchID,
        member.user_id as UserID,
        { enforceAccess: false }
      )
    ).toBeNull();
  });

  dbTest('cannot become any board primary teammate', async ({ db }) => {
    const { board_id } = await seedExampleBoard(db);
    const wendy = (await new BranchRepository(db).findAll()).find((b) => isTeammate(b))!;
    await expect(
      new BoardRepository(db).setPrimaryTeammate(board_id!, wendy.branch_id)
    ).rejects.toThrow('The example teammate cannot be a primary teammate');
  });

  dbTest('cannot be a gateway target', async ({ db }) => {
    await seedExampleBoard(db);
    const [branch] = await new BranchRepository(db).findAll();
    await expect(
      new GatewayChannelRepository(db).create({
        name: 'Example',
        created_by: branch.created_by as UUID,
        target_branch_id: branch.branch_id as UUID,
        enabled: false,
        config: { bot_token: 'bot-test', app_token: 'app-test' },
      })
    ).rejects.toThrow('Example branches cannot be a gateway target');
  });

  dbTest('is left out of totals that use notExampleBoardOwned', async ({ db }) => {
    await seedExampleBoard(db);
    const counted = await select(db, { id: tasks.task_id })
      .from(tasks)
      .where(notExampleBoardOwned(tasks.created_by))
      .all();
    expect(counted).toEqual([]);
    expect(await new TaskRepository(db).findAll()).not.toEqual([]);
  });
});
