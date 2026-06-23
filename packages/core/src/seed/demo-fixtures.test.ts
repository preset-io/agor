/**
 * loadDemoFixtures Tests
 *
 * Verifies the LOAD_FIXTURES demo seeder against a fresh in-memory database:
 * per-entity row counts, idempotency (no duplicates on re-run), loginable
 * (bcrypt-hashed) demo users, session/task metadata consistency, genealogy
 * wiring, and the artifact board-object layout entry shape.
 */

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { select } from '../db/database-wrapper';
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
import { users } from '../db/schema';
import { dbTest } from '../db/test-helpers';
import { DEMO_USER_CREDENTIALS, loadDemoFixtures } from './demo-fixtures';

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

    // Branch + card placements are board_objects rows (5 branches + 4 cards).
    const placements = await boardObjectRepo.findByBoardId(board!.board_id);
    expect(placements).toHaveLength(9);
  });

  dbTest('creates loginable demo users with bcrypt-hashed passwords', async ({ db }) => {
    await loadDemoFixtures({ db, skipIfExists: true });

    for (const cred of DEMO_USER_CREDENTIALS) {
      // Read the RAW row to inspect the stored password (the public User DTO omits it).
      const row = await select(db).from(users).where(eq(users.email, cred.email)).one();
      expect(row).not.toBeNull();
      const stored = (row as { password: string }).password;

      // Stored value must be a bcrypt hash, not the cleartext.
      expect(stored).toMatch(/^\$2[aby]\$/);
      expect(stored).not.toBe(cred.password);

      // ...and the known cleartext must verify against it (i.e. the user can log in).
      expect(await bcrypt.compare(cred.password, stored)).toBe(true);
    }
  });

  dbTest('wires session metadata + genealogy consistently', async ({ db }) => {
    await loadDemoFixtures({ db, skipIfExists: true });

    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);
    const sessions = await sessionRepo.findAll();
    const tasks = await taskRepo.findAll();

    // Each session's data.tasks must exactly match the task rows pointing at it.
    for (const session of sessions) {
      const taskIdsForSession = tasks
        .filter((t) => t.session_id === session.session_id)
        .map((t) => t.task_id)
        .sort();
      expect([...(session.tasks ?? [])].sort()).toEqual(taskIdsForSession);
      expect(session.tasks).toHaveLength(1);
    }

    // Root session = the one referenced as parent/fork-source by its children.
    const root = sessions.find((s) => s.title === 'Implement login form');
    expect(root).toBeDefined();

    const spawnedChild = sessions.find((s) => s.genealogy?.parent_session_id === root!.session_id);
    const forkedChild = sessions.find(
      (s) => s.genealogy?.forked_from_session_id === root!.session_id
    );
    expect(spawnedChild).toBeDefined();
    expect(forkedChild).toBeDefined();

    // Root genealogy.children must include BOTH the spawned and forked child.
    expect(root!.genealogy?.children).toHaveLength(2);
    expect(root!.genealogy?.children).toEqual(
      expect.arrayContaining([spawnedChild!.session_id, forkedChild!.session_id])
    );

    // fork/spawn point fields live on the CHILDREN only, never on the root.
    expect(root!.genealogy?.spawn_point_task_id).toBeUndefined();
    expect(root!.genealogy?.fork_point_task_id).toBeUndefined();
    expect(spawnedChild!.genealogy?.spawn_point_task_id).toBeDefined();
    expect(forkedChild!.genealogy?.fork_point_task_id).toBeDefined();
  });

  dbTest('places a non-empty artifact via a board.data.objects entry', async ({ db }) => {
    await loadDemoFixtures({ db, skipIfExists: true });

    const artifactRepo = new ArtifactRepository(db);
    const boardRepo = new BoardRepository(db);

    const artifacts = await artifactRepo.findAll();
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0];

    // Artifact carries a non-empty Sandpack file map.
    expect(artifact.files).toBeDefined();
    expect(Object.keys(artifact.files ?? {}).length).toBeGreaterThan(0);

    // Layout entry lives in board.data.objects, keyed `artifact-<id>`, with the
    // exact ArtifactBoardObject shape (no board_objects row for artifacts).
    const board = await boardRepo.findBySlug('demo-board');
    const entry = board?.objects?.[`artifact-${artifact.artifact_id}`];
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      type: 'artifact',
      artifact_id: artifact.artifact_id,
    });
    const layout = entry as { x: number; y: number; width: number; height: number };
    expect(typeof layout.x).toBe('number');
    expect(typeof layout.y).toBe('number');
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
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
