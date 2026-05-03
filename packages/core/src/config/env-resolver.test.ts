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
import { beforeAll, describe, expect } from 'vitest';
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

// Force real AES encryption so URL-shaped tool config (e.g. ANTHROPIC_BASE_URL)
// round-trips without tripping decryptApiKey's dev-mode `:` heuristic.
beforeAll(() => {
  if (!process.env.AGOR_MASTER_SECRET) {
    process.env.AGOR_MASTER_SECRET = 'test-master-secret-env-resolver';
  }
});

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
  // Patch the user's JSON `data.env_vars` directly. UsersRepository has no
  // public env_vars mutator (managed by the daemon services layer); writing
  // the stored shape ourselves is the cleanest way to exercise the resolver.
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

// ============================================================================
// Per-tool credential scoping (cross-SDK isolation)
//
// Verifies that `resolveUserEnvironment(..., { tool })` merges ONLY the
// requested tool's credentials from `data.agentic_tools[tool]` and never
// leaks credentials from other tools' buckets — the security regression
// that motivated PR #1077.
// ============================================================================

describe('resolveUserEnvironment — per-tool credential scoping', () => {
  /**
   * Seed a user with full per-tool credential blobs across multiple tools so
   * we can verify that selecting one tool does not surface another's keys.
   * Mirrors the on-disk shape: `data.agentic_tools[tool][envVarName] = encrypted`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  async function createUserWithToolCreds(db: any): Promise<UserID> {
    const usersRepo = new UsersRepository(db);
    const user = await usersRepo.create({
      email: `tool-test-${Date.now()}-${Math.random()}@example.com`,
      name: 'Tool Test',
    });
    const userId = user.user_id as UserID;

    await usersRepo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'anthropic-key');
    await usersRepo.setToolConfigField(
      userId,
      'claude-code',
      'ANTHROPIC_BASE_URL',
      'https://gateway.example.com'
    );
    await usersRepo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'openai-key');
    await usersRepo.setToolConfigField(userId, 'gemini', 'GEMINI_API_KEY', 'gemini-key');
    await usersRepo.setToolConfigField(userId, 'copilot', 'COPILOT_GITHUB_TOKEN', 'gh-copilot');

    return userId;
  }

  dbTest('omitting `tool` excludes ALL per-tool credentials', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db);
    // Safe default: worktree-level terminals don't run an SDK and shouldn't
    // see any per-SDK keys.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  dbTest('tool=claude-code merges only claude-code fields', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db, { tool: 'claude-code' });
    expect(env.ANTHROPIC_API_KEY).toBe('anthropic-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com');
    // Other tools' credentials must NOT leak.
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  dbTest('tool=codex merges only OPENAI_API_KEY', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db, { tool: 'codex' });
    expect(env.OPENAI_API_KEY).toBe('openai-key');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  dbTest('tool=gemini merges only GEMINI_API_KEY', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db, { tool: 'gemini' });
    expect(env.GEMINI_API_KEY).toBe('gemini-key');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  dbTest('tool=copilot merges only COPILOT_GITHUB_TOKEN', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db, { tool: 'copilot' });
    expect(env.COPILOT_GITHUB_TOKEN).toBe('gh-copilot');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  dbTest('tool credentials override same-named global env vars', async ({ db }) => {
    // Seed env_vars with a global ANTHROPIC_API_KEY, then set a different
    // value via the agentic_tools bucket. The tool-scoped value should win
    // because per-SDK config is the explicit "use this for this tool" surface.
    const usersRepo = new UsersRepository(db);
    const user = await usersRepo.create({
      email: `precedence-${Date.now()}-${Math.random()}@example.com`,
      name: 'Precedence',
    });
    const userId = user.user_id as UserID;

    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    const currentData = (row?.data as Record<string, unknown>) ?? {};
    await update(db, users)
      .set({
        data: {
          ...currentData,
          env_vars: {
            ANTHROPIC_API_KEY: encEntry('global-fallback', 'global'),
          },
        },
      })
      .where(eq(users.user_id, userId))
      .run();

    await usersRepo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'tool-specific');

    const envWithTool = await resolveUserEnvironment(userId, db, { tool: 'claude-code' });
    expect(envWithTool.ANTHROPIC_API_KEY).toBe('tool-specific');

    // Without `tool`, the global env var still wins (no tool merge happens).
    const envNoTool = await resolveUserEnvironment(userId, db);
    expect(envNoTool.ANTHROPIC_API_KEY).toBe('global-fallback');
  });
});
