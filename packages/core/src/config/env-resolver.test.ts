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

import type { BranchID, Session, SessionID, UserID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { select, update } from '../db/database-wrapper';
import { encryptApiKey } from '../db/encryption';
import { BranchRepository } from '../db/repositories/branches';
import { RepoRepository } from '../db/repositories/repos';
import { SessionEnvSelectionRepository } from '../db/repositories/session-env-selections';
import { SessionRepository } from '../db/repositories/sessions';
import { UsersRepository } from '../db/repositories/users';
import { users } from '../db/schema';
import { dbTest } from '../db/test-helpers';
import { generateId } from '../lib/ids';
import {
  AGOR_USER_ENV_KEYS_VAR,
  createUserProcessEnvironment,
  resolveUserEnvironment,
  SESSION_CONTEXT_CREDENTIAL_KEYS,
} from './env-resolver';
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
  const branchRepo = new BranchRepository(db);
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

  const branch = await branchRepo.create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: userId,
  });

  const data: Partial<Session> = {
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id,
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
    await usersRepo.setToolConfigField(
      userId,
      'codex',
      'OPENAI_BASE_URL',
      'https://codex-gateway.example.com/v1'
    );
    await usersRepo.setToolConfigField(userId, 'gemini', 'GEMINI_API_KEY', 'gemini-key');
    await usersRepo.setToolConfigField(userId, 'copilot', 'COPILOT_GITHUB_TOKEN', 'gh-copilot');
    await usersRepo.setToolConfigField(userId, 'cursor', 'CURSOR_API_KEY', 'cursor-key');

    return userId;
  }

  dbTest('omitting `tool` excludes ALL per-tool credentials', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db);
    // Safe default: branch-level terminals don't run an SDK and shouldn't
    // see any per-SDK keys.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
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
    expect(env.CURSOR_API_KEY).toBeUndefined();
  });

  dbTest('tool=codex merges OPENAI_API_KEY + OPENAI_BASE_URL only', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db, { tool: 'codex' });
    expect(env.OPENAI_API_KEY).toBe('openai-key');
    // Per-user custom OpenAI-compatible endpoint (vLLM, Ollama, internal gateway, etc.)
    // must propagate so the executor's Codex SDK picks it up.
    expect(env.OPENAI_BASE_URL).toBe('https://codex-gateway.example.com/v1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
  });

  dbTest('tool=gemini merges only GEMINI_API_KEY', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db, { tool: 'gemini' });
    expect(env.GEMINI_API_KEY).toBe('gemini-key');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
  });

  dbTest('tool=copilot merges only COPILOT_GITHUB_TOKEN', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db, { tool: 'copilot' });
    expect(env.COPILOT_GITHUB_TOKEN).toBe('gh-copilot');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
  });

  dbTest('tool=cursor merges only CURSOR_API_KEY', async ({ db }) => {
    const userId = await createUserWithToolCreds(db);
    const env = await resolveUserEnvironment(userId, db, { tool: 'cursor' });
    expect(env.CURSOR_API_KEY).toBe('cursor-key');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
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

// ============================================================================
// Git identity mirroring
//
// When a user sets GIT_AUTHOR_NAME/EMAIL but not GIT_COMMITTER_NAME/EMAIL,
// createUserProcessEnvironment should mirror author → committer so that git
// commits don't split author (user) from committer (system git config owner).
// ============================================================================

describe('createUserProcessEnvironment — git identity mirroring', () => {
  // Ensure GIT_COMMITTER_* are absent from the test process environment so
  // buildAllowlistedEnv() doesn't pre-populate them and mask the mirroring.
  const savedCommitterName = process.env.GIT_COMMITTER_NAME;
  const savedCommitterEmail = process.env.GIT_COMMITTER_EMAIL;
  const savedAuthorName = process.env.GIT_AUTHOR_NAME;
  const savedAuthorEmail = process.env.GIT_AUTHOR_EMAIL;

  beforeAll(() => {
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
  });

  afterAll(() => {
    if (savedCommitterName !== undefined) process.env.GIT_COMMITTER_NAME = savedCommitterName;
    if (savedCommitterEmail !== undefined) process.env.GIT_COMMITTER_EMAIL = savedCommitterEmail;
    if (savedAuthorName !== undefined) process.env.GIT_AUTHOR_NAME = savedAuthorName;
    if (savedAuthorEmail !== undefined) process.env.GIT_AUTHOR_EMAIL = savedAuthorEmail;
  });

  dbTest('mirrors author → committer when only author vars are set', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      GIT_AUTHOR_NAME: encEntry('Alice Dev', 'global'),
      GIT_AUTHOR_EMAIL: encEntry('alice@example.com', 'global'),
    });

    const env = await createUserProcessEnvironment(userId, db);
    expect(env.GIT_AUTHOR_NAME).toBe('Alice Dev');
    expect(env.GIT_AUTHOR_EMAIL).toBe('alice@example.com');
    expect(env.GIT_COMMITTER_NAME).toBe('Alice Dev');
    expect(env.GIT_COMMITTER_EMAIL).toBe('alice@example.com');
  });

  dbTest('does not override explicitly set committer vars', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      GIT_AUTHOR_NAME: encEntry('Alice Dev', 'global'),
      GIT_AUTHOR_EMAIL: encEntry('alice@example.com', 'global'),
      GIT_COMMITTER_NAME: encEntry('Alice Bot', 'global'),
      GIT_COMMITTER_EMAIL: encEntry('alice-bot@example.com', 'global'),
    });

    const env = await createUserProcessEnvironment(userId, db);
    expect(env.GIT_COMMITTER_NAME).toBe('Alice Bot');
    expect(env.GIT_COMMITTER_EMAIL).toBe('alice-bot@example.com');
  });

  dbTest('mirrors independently — name without email and vice versa', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      GIT_AUTHOR_NAME: encEntry('Alice Dev', 'global'),
      GIT_AUTHOR_EMAIL: encEntry('alice@example.com', 'global'),
      GIT_COMMITTER_EMAIL: encEntry('alice-committer@example.com', 'global'),
      // GIT_COMMITTER_NAME intentionally absent
    });

    const env = await createUserProcessEnvironment(userId, db);
    expect(env.GIT_COMMITTER_NAME).toBe('Alice Dev'); // mirrored
    expect(env.GIT_COMMITTER_EMAIL).toBe('alice-committer@example.com'); // unchanged
  });

  dbTest('no-op when neither author nor committer vars are set', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      GITHUB_TOKEN: encEntry('gh-secret', 'global'),
    });

    const env = await createUserProcessEnvironment(userId, db);
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_NAME).toBeUndefined();
  });

  dbTest('mirrors committer → author when only committer vars are set', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      GIT_COMMITTER_NAME: encEntry('Bob Ops', 'global'),
      GIT_COMMITTER_EMAIL: encEntry('bob@example.com', 'global'),
    });

    const env = await createUserProcessEnvironment(userId, db);
    expect(env.GIT_COMMITTER_NAME).toBe('Bob Ops');
    expect(env.GIT_COMMITTER_EMAIL).toBe('bob@example.com');
    expect(env.GIT_AUTHOR_NAME).toBe('Bob Ops');
    expect(env.GIT_AUTHOR_EMAIL).toBe('bob@example.com');
  });

  dbTest('cross-mirrors author name and committer email independently', async ({ db }) => {
    const userId = await createUserWithEnv(db, {
      GIT_AUTHOR_NAME: encEntry('Carol Dev', 'global'),
      GIT_COMMITTER_EMAIL: encEntry('carol@example.com', 'global'),
      // GIT_AUTHOR_EMAIL and GIT_COMMITTER_NAME intentionally absent
    });

    const env = await createUserProcessEnvironment(userId, db);
    expect(env.GIT_AUTHOR_NAME).toBe('Carol Dev');
    expect(env.GIT_COMMITTER_NAME).toBe('Carol Dev'); // mirrored from author
    expect(env.GIT_COMMITTER_EMAIL).toBe('carol@example.com');
    expect(env.GIT_AUTHOR_EMAIL).toBe('carol@example.com'); // mirrored from committer
  });
});

// ============================================================================
// session.custom_context → executor env (sibling channel to PR #1287)
//
// PR #1287 wired `session.custom_context.*` into the MCP template resolver so
// a session opener could pin per-session credentials onto MCP server configs
// without writing to any persistent user record. This block verifies the
// matching wiring for the executor's own env: same channel, same security
// envelope, allowlist-restricted to known model-credential keys.
// ============================================================================

describe('createUserProcessEnvironment — session.custom_context credential overrides', () => {
  dbTest('allowlisted keys flow from custom_context into the executor env', async ({ db }) => {
    const userId = await createUserWithEnv(db, {});
    const env = await createUserProcessEnvironment(
      userId,
      db,
      undefined,
      false,
      undefined,
      undefined,
      'claude-code',
      {
        ANTHROPIC_API_KEY: 'sk-or-from-session',
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
      }
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-or-from-session');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });

  dbTest('non-allowlisted keys are silently dropped (no env smuggling)', async ({ db }) => {
    // A session opener with stolen impersonation credentials must not be
    // able to inject PATH, LD_PRELOAD, AGOR_MASTER_SECRET, or arbitrary
    // internals via the custom_context channel. The allowlist is enforced
    // in env-resolver, not at the HTTP boundary, so a leaked impersonation
    // key never escalates into arbitrary env control.
    const userId = await createUserWithEnv(db, {});
    const env = await createUserProcessEnvironment(
      userId,
      db,
      undefined,
      false,
      undefined,
      undefined,
      'claude-code',
      {
        ANTHROPIC_API_KEY: 'allowed',
        PATH: '/evil/bin:/usr/bin',
        LD_PRELOAD: '/tmp/evil.so',
        AGOR_MASTER_SECRET: 'oops',
        SOME_RANDOM_KEY: 'nope',
      }
    );
    expect(env.ANTHROPIC_API_KEY).toBe('allowed');
    // PATH may exist via the process.env allowlist, but must not be the
    // attacker-supplied value.
    expect(env.PATH).not.toBe('/evil/bin:/usr/bin');
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.AGOR_MASTER_SECRET).toBeUndefined();
    expect(env.SOME_RANDOM_KEY).toBeUndefined();
  });

  dbTest('omitting custom_context is a no-op', async ({ db }) => {
    const userId = await createUserWithEnv(db, {});
    const env = await createUserProcessEnvironment(userId, db);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  dbTest(
    'custom_context wins over per-user credential (opener-pinned beats persisted)',
    async ({ db }) => {
      // The whole point of the channel: per-session ephemeral credentials
      // override per-user persistent ones. An embedding host can use this
      // to forward a per-session model key (e.g. one minted for the
      // current end-user, scoped to a single session's lifetime) without
      // touching the per-user record.
      const usersRepo = new UsersRepository(db);
      const user = await usersRepo.create({
        email: `cc-override-${Date.now()}-${Math.random()}@example.com`,
        name: 'CC Override',
      });
      const userId = user.user_id as UserID;
      await usersRepo.setToolConfigField(
        userId,
        'claude-code',
        'ANTHROPIC_API_KEY',
        'persistent-user-key'
      );

      const env = await createUserProcessEnvironment(
        userId,
        db,
        undefined,
        false,
        undefined,
        undefined,
        'claude-code',
        { ANTHROPIC_API_KEY: 'per-session-key' }
      );
      expect(env.ANTHROPIC_API_KEY).toBe('per-session-key');
    }
  );

  dbTest('additionalEnv still beats custom_context', async ({ db }) => {
    // additionalEnv is the explicit caller-controlled top of the stack
    // (typically reserved for gateway force-overrides or daemon-internal
    // policy). It must remain above the session-opener channel.
    const userId = await createUserWithEnv(db, {});
    const env = await createUserProcessEnvironment(
      userId,
      db,
      { ANTHROPIC_API_KEY: 'top-of-stack' },
      false,
      undefined,
      undefined,
      'claude-code',
      { ANTHROPIC_API_KEY: 'from-session' }
    );
    expect(env.ANTHROPIC_API_KEY).toBe('top-of-stack');
  });

  dbTest('empty-string and non-string values are ignored', async ({ db }) => {
    const userId = await createUserWithEnv(db, {});
    const env = await createUserProcessEnvironment(
      userId,
      db,
      undefined,
      false,
      undefined,
      undefined,
      'claude-code',
      {
        ANTHROPIC_API_KEY: '',
        // biome-ignore lint/suspicious/noExplicitAny: type-erased opener payload
        ANTHROPIC_BASE_URL: 12345 as any,
        // biome-ignore lint/suspicious/noExplicitAny: type-erased opener payload
        OPENAI_API_KEY: null as any,
      }
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  dbTest('keys from custom_context are tracked in AGOR_USER_ENV_KEYS', async ({ db }) => {
    // MCP template resolver reads AGOR_USER_ENV_KEYS to know which vars are
    // user-scoped vs daemon-internal. Custom-context-supplied credentials are
    // opener-scoped, which counts as user-scoped for the template's purposes.
    const userId = await createUserWithEnv(db, {});
    const env = await createUserProcessEnvironment(
      userId,
      db,
      undefined,
      false,
      undefined,
      undefined,
      'claude-code',
      {
        ANTHROPIC_API_KEY: 'a',
        ANTHROPIC_BASE_URL: 'https://b',
      }
    );
    const keys = new Set(env[AGOR_USER_ENV_KEYS_VAR]?.split(',') ?? []);
    expect(keys.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(keys.has('ANTHROPIC_BASE_URL')).toBe(true);
  });

  dbTest('allowlist contract — must cover all ConfigCredentialKey + OPENAI_BASE_URL', async () => {
    // Lock the allowlist contents into the test surface so a future edit
    // that drops a key here trips a test, not a silent prod regression.
    expect(SESSION_CONTEXT_CREDENTIAL_KEYS).toEqual(
      new Set([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'GEMINI_API_KEY',
      ])
    );
  });
});
