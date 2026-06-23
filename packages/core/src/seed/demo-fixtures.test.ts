/**
 * loadDemoFixtures Tests
 *
 * Verifies the LOAD_FIXTURES demo seeder against a fresh in-memory database:
 * per-entity row counts on first run, and idempotency (no duplicates) when
 * re-run.
 */

import { describe, expect } from 'vitest';
import {
  ArtifactRepository,
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CardRepository,
  CardTypeRepository,
  MessagesRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '../db/repositories';
import { dbTest } from '../db/test-helpers';
import { loadDemoFixtures } from './demo-fixtures';

describe('loadDemoFixtures', () => {
  dbTest('inserts the expected demo entities on a fresh database', async ({ db }) => {
    const result = await loadDemoFixtures({ db, skipIfExists: true });

    expect(result.skipped).toBe(false);
    expect(result.counts).toEqual({
      users: 4,
      card_types: 3,
      repos: 2,
      boards: 1,
      branches: 5,
      sessions: 4,
      tasks: 4,
      messages: 16,
      cards: 4,
      artifacts: 1,
    });

    // Cross-check actual rows landed in the DB.
    const usersRepo = new UsersRepository(db);
    const cardTypeRepo = new CardTypeRepository(db);
    const repoRepo = new RepoRepository(db);
    const branchRepo = new BranchRepository(db);
    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);
    const messagesRepo = new MessagesRepository(db);
    const cardRepo = new CardRepository(db);
    const artifactRepo = new ArtifactRepository(db);
    const boardRepo = new BoardRepository(db);
    const boardObjectRepo = new BoardObjectRepository(db);

    const demoUsers = (await usersRepo.findAll()).filter((u) => u.email.startsWith('demo.'));
    expect(demoUsers).toHaveLength(4);

    const demoTypes = (await cardTypeRepo.findAll()).filter((t) => t.name.startsWith('Demo'));
    expect(demoTypes).toHaveLength(3);

    const demoRepos = (await repoRepo.findAll()).filter((r) => r.slug.startsWith('demo-'));
    expect(demoRepos).toHaveLength(2);

    const demoBranches = (await branchRepo.findAll()).filter((b) => b.name.startsWith('demo-'));
    expect(demoBranches).toHaveLength(5);

    expect(await sessionRepo.findAll()).toHaveLength(4);
    expect(await taskRepo.findAll()).toHaveLength(4);
    expect(await messagesRepo.findAll()).toHaveLength(16);
    expect(await cardRepo.findAll()).toHaveLength(4);
    expect(await artifactRepo.findAll()).toHaveLength(1);

    // Board with zones.
    const board = await boardRepo.findBySlug('demo-board');
    expect(board).not.toBeNull();
    const objects = board?.objects ?? {};
    const zones = Object.values(objects).filter((o) => o.type === 'zone');
    expect(zones).toHaveLength(4);
    const artifactEntries = Object.values(objects).filter((o) => o.type === 'artifact');
    expect(artifactEntries).toHaveLength(1);

    // Branch + card placements are board_objects rows (5 branches + 4 cards).
    const placements = await boardObjectRepo.findByBoardId(board!.board_id);
    expect(placements).toHaveLength(9);

    // Genealogy: one spawned child + one forked sibling reference the root.
    const sessions = await sessionRepo.findAll();
    const withParent = sessions.filter((s) => s.genealogy?.parent_session_id);
    const withFork = sessions.filter((s) => s.genealogy?.forked_from_session_id);
    expect(withParent).toHaveLength(1);
    expect(withFork).toHaveLength(1);
  });

  dbTest('is idempotent — re-running does not duplicate rows', async ({ db }) => {
    const first = await loadDemoFixtures({ db, skipIfExists: true });
    expect(first.skipped).toBe(false);

    const second = await loadDemoFixtures({ db, skipIfExists: true });
    expect(second.skipped).toBe(true);

    // Run a third time without skipIfExists — still a no-op (sentinel guards it).
    const third = await loadDemoFixtures({ db });
    expect(third.skipped).toBe(true);

    const usersRepo = new UsersRepository(db);
    const demoUsers = (await usersRepo.findAll()).filter((u) => u.email.startsWith('demo.'));
    expect(demoUsers).toHaveLength(4);

    const messagesRepo = new MessagesRepository(db);
    expect(await messagesRepo.findAll()).toHaveLength(16);
  });
});
