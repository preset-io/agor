/**
 * Env resolver — scope filtering tests (v0.5 env-var-access).
 *
 * Verifies that `resolveUserEnvironment`:
 *   - always includes `scope: 'global'` entries
 *   - includes `scope: 'session'` entries ONLY when a matching selection row
 *     exists in `session_env_selections` for the given sessionId
 *   - skips reserved-for-v1 scopes (repo / mcp_server / etc.)
 *   - treats legacy plain-string entries as global-scope
 */

import type { Session, SessionID, UserID, UUID, WorktreeID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { select, update } from '../db/database-wrapper';
import { encryptApiKey } from '../db/encryption';
import { RepoRepository } from '../db/repositories/repos';
import { SessionEnvSelectionRepository } from '../db/repositories/session-env-selections';
import { SessionRepository } from '../db/repositories/sessions';
import { UsersRepository } from '../db/repositories/users';
import { WorktreeRepository } from '../db/repositories/worktrees';
import { users } from '../db/schema';
import { dbTest } from '../db/test-helpers';
import { generateId } from '../lib/ids';
import { resolveUserEnvironment } from './env-resolver';
import type { StoredEnvVar } from './env-vars';

function encEntry(value: string, scope: StoredEnvVar['scope']): StoredEnvVar {
  return {
    value_encrypted: encryptApiKey(value),
    scope,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper
async function createUserWithEnv(db: any, envVars: Record<string, unknown>): Promise<UserID> {
  const usersRepo = new UsersRepository(db);
  const user = await usersRepo.create({
    email: `test-${Date.now()}-${Math.random()}@example.com`,
    name: 'Test',
  });
  // Patch the user's JSON `data.env_vars` directly. UsersRepository.userToInsert
  // doesn't currently persist env_vars (only raw api_keys), so we write the
  // stored shape ourselves to exercise the resolver.
  const row = await select(db).from(users).where(eq(users.user_id, user.user_id)).one();
  const currentData =
    (row?.data as Record<string, unknown> | undefined) ?? ({} as Record<string, unknown>);
  await update(db, users)
    .set({ data: { ...currentData, env_vars: envVars } })
    .where(eq(users.user_id, user.user_id))
    .run();
  return user.user_id as UserID;
}

// biome-ignore lint/suspicious/noExplicitAny: test helper
async function createSessionForUser(db: any, userId: UserID): Promise<SessionID> {
  const repoRepo = new RepoRepository(db);
  const worktreeRepo = new WorktreeRepository(db);
  const sessionRepo = new SessionRepository(db);

  const repo = await repoRepo.create({
    repo_id: generateId() as UUID,
    slug: `test-repo-${Date.now()}-${Math.random()}`,
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
    worktree_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
  });

  const data: Partial<Session> = {
    session_id: generateId() as SessionID,
    worktree_id: worktree.worktree_id,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: userId,
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    git_state: { ref: 'main', base_sha: 'a', current_sha: 'b' },
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
  };
  const session = await sessionRepo.create(data);
  return session.session_id as SessionID;
}

describe('resolveUserEnvironment — scope filtering (v0.5)', () => {
  dbTest('global-scope vars are always included', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      GITHUB_TOKEN: encEntry('gh-secret', 'global'),
    });

    const env = await resolveUserEnvironment(userId, db);
    expect(env.GITHUB_TOKEN).toBe('gh-secret');
  });

  dbTest('session-scope vars are EXCLUDED when no sessionId is provided', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      SESSION_ONLY: encEntry('session-secret', 'session'),
    });

    const env = await resolveUserEnvironment(userId, db);
    expect(env.SESSION_ONLY).toBeUndefined();
  });

  dbTest(
    'session-scope vars are EXCLUDED when sessionId has no matching selection',
    async ({ db }) => {
      const userId = await createUserWithEnv(db, {
        SESSION_ONLY: encEntry('session-secret', 'session'),
      });
      const sessionId = await createSessionForUser(db, userId);

      const env = await resolveUserEnvironment(userId, db, { sessionId });
      expect(env.SESSION_ONLY).toBeUndefined();
    }
  );

  dbTest('session-scope vars are INCLUDED when selected for the session', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      SESSION_ONLY: encEntry('session-secret', 'session'),
      OTHER_SESSION: encEntry('not-selected', 'session'),
      GITHUB_TOKEN: encEntry('gh', 'global'),
    });
    const sessionId = await createSessionForUser(db, userId);
    const selRepo = new SessionEnvSelectionRepository(db);
    await selRepo.add(sessionId, 'SESSION_ONLY');

    const env = await resolveUserEnvironment(userId, db, { sessionId });
    expect(env.SESSION_ONLY).toBe('session-secret');
    expect(env.OTHER_SESSION).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe('gh'); // global still included
  });

  dbTest('reserved-for-v1 scope values are skipped', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      REPO_SCOPED: {
        value_encrypted: encryptApiKey('repo-secret'),
        scope: 'repo',
        resource_id: 'some-repo-id',
      },
      MCP_SCOPED: {
        value_encrypted: encryptApiKey('mcp-secret'),
        scope: 'mcp_server',
        resource_id: 'some-mcp-id',
      },
    });
    const sessionId = await createSessionForUser(db, userId);

    const env = await resolveUserEnvironment(userId, db, { sessionId });
    expect(env.REPO_SCOPED).toBeUndefined();
    expect(env.MCP_SCOPED).toBeUndefined();
  });

  dbTest('legacy plain-string entries are treated as global-scope', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      // Legacy shape: plain encrypted string, no scope metadata
      LEGACY_VAR: encryptApiKey('legacy-value'),
    });

    const env = await resolveUserEnvironment(userId, db);
    expect(env.LEGACY_VAR).toBe('legacy-value');
  });

  dbTest('selection for one session does not leak to another session', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      SHARED_NAME: encEntry('secret', 'session'),
    });
    const sessionA = await createSessionForUser(db, userId);
    const sessionB = await createSessionForUser(db, userId);
    const selRepo = new SessionEnvSelectionRepository(db);
    await selRepo.add(sessionA, 'SHARED_NAME');

    const envA = await resolveUserEnvironment(userId, db, { sessionId: sessionA });
    const envB = await resolveUserEnvironment(userId, db, { sessionId: sessionB });
    expect(envA.SHARED_NAME).toBe('secret');
    expect(envB.SHARED_NAME).toBeUndefined();
  });
});
