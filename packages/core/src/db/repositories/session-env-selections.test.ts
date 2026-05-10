/**
 * Session Env Selection Repository Tests
 *
 * CRUD + cascade + membership semantics for the v0.5 env-var-access join table.
 */

import type { Session, SessionID, UUID, WorktreeID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { RepoRepository } from './repos';
import { SessionEnvSelectionRepository } from './session-env-selections';
import { SessionRepository } from './sessions';
import { WorktreeRepository } from './worktrees';

function createSessionData(worktreeId: UUID, overrides?: Partial<Session>): Partial<Session> {
  return {
    session_id: (overrides?.session_id ?? generateId()) as SessionID,
    worktree_id: worktreeId,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: 'test-user',
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper
async function setup(db: any) {
  const repoRepo = new RepoRepository(db);
  const worktreeRepo = new WorktreeRepository(db);
  const sessionRepo = new SessionRepository(db);

  const repo = await repoRepo.create({
    repo_id: generateId() as UUID,
    slug: `test-repo-${Date.now()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });

  const worktree = await worktreeRepo.create({
    worktree_id: generateId() as WorktreeID,
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    worktree_unique_id: Math.floor(Math.random() * 1000000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: 'test-user' as UUID,
  });

  const session = await sessionRepo.create(createSessionData(worktree.worktree_id));
  const otherSession = await sessionRepo.create(createSessionData(worktree.worktree_id));

  return { session, otherSession, sessionRepo };
}

describe('SessionEnvSelectionRepository.add / listNames', () => {
  dbTest('adds a single selection', async ({ db }) => {
    const { session } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.add(session.session_id as SessionID, 'GITHUB_TOKEN');
    const names = await repo.listNames(session.session_id as SessionID);
    expect(names).toEqual(['GITHUB_TOKEN']);
  });

  dbTest('is idempotent: adding the same name twice yields one row', async ({ db }) => {
    const { session } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.add(session.session_id as SessionID, 'GITHUB_TOKEN');
    await repo.add(session.session_id as SessionID, 'GITHUB_TOKEN');

    const names = await repo.listNames(session.session_id as SessionID);
    expect(names).toEqual(['GITHUB_TOKEN']);
  });

  dbTest('keeps selections per-session', async ({ db }) => {
    const { session, otherSession } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.add(session.session_id as SessionID, 'GITHUB_TOKEN');
    await repo.add(otherSession.session_id as SessionID, 'STRIPE_API_KEY');

    expect(await repo.listNames(session.session_id as SessionID)).toEqual(['GITHUB_TOKEN']);
    expect(await repo.listNames(otherSession.session_id as SessionID)).toEqual(['STRIPE_API_KEY']);
  });
});

describe('SessionEnvSelectionRepository.remove', () => {
  dbTest('removes a selection', async ({ db }) => {
    const { session } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.add(session.session_id as SessionID, 'GITHUB_TOKEN');
    await repo.remove(session.session_id as SessionID, 'GITHUB_TOKEN');

    expect(await repo.listNames(session.session_id as SessionID)).toEqual([]);
  });

  dbTest('is a no-op when the selection does not exist', async ({ db }) => {
    const { session } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await expect(
      repo.remove(session.session_id as SessionID, 'NOT_PRESENT')
    ).resolves.toBeUndefined();
  });
});

describe('SessionEnvSelectionRepository.setAll', () => {
  dbTest('replaces all selections', async ({ db }) => {
    const { session } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.add(session.session_id as SessionID, 'GITHUB_TOKEN');
    await repo.add(session.session_id as SessionID, 'STRIPE_API_KEY');

    await repo.setAll(session.session_id as SessionID, ['DATABASE_URL', 'FLY_API_TOKEN']);

    const names = await repo.listNames(session.session_id as SessionID);
    expect(names.sort()).toEqual(['DATABASE_URL', 'FLY_API_TOKEN']);
  });

  dbTest('setting empty list clears all rows for the session', async ({ db }) => {
    const { session } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.add(session.session_id as SessionID, 'GITHUB_TOKEN');
    await repo.setAll(session.session_id as SessionID, []);

    expect(await repo.listNames(session.session_id as SessionID)).toEqual([]);
  });

  dbTest('setAll does not affect other sessions', async ({ db }) => {
    const { session, otherSession } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.setAll(session.session_id as SessionID, ['A', 'B']);
    await repo.setAll(otherSession.session_id as SessionID, ['C']);

    expect((await repo.listNames(session.session_id as SessionID)).sort()).toEqual(['A', 'B']);
    expect(await repo.listNames(otherSession.session_id as SessionID)).toEqual(['C']);
  });
});

describe('SessionEnvSelectionRepository.asSet', () => {
  dbTest('returns a Set for O(1) membership checks', async ({ db }) => {
    const { session } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.setAll(session.session_id as SessionID, ['GITHUB_TOKEN', 'DATABASE_URL']);
    const set = await repo.asSet(session.session_id as SessionID);

    expect(set.has('GITHUB_TOKEN')).toBe(true);
    expect(set.has('DATABASE_URL')).toBe(true);
    expect(set.has('NOT_SELECTED')).toBe(false);
  });
});

describe('SessionEnvSelectionRepository — cascade on session delete', () => {
  dbTest('deleting a session removes its env selections', async ({ db }) => {
    const { session, sessionRepo } = await setup(db);
    const repo = new SessionEnvSelectionRepository(db);

    await repo.setAll(session.session_id as SessionID, ['GITHUB_TOKEN']);
    await sessionRepo.delete(session.session_id);

    expect(await repo.listNames(session.session_id as SessionID)).toEqual([]);
  });
});
