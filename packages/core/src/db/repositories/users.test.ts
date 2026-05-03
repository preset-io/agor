/**
 * UsersRepository Tests
 *
 * Focuses on the per-tool credential mutators introduced in PR #1077:
 *   - setToolConfigField  (encrypts + persists under data.agentic_tools[tool][field])
 *   - getToolConfig       (returns full decrypted bag for a tool)
 *   - getToolConfigField  (returns single decrypted value)
 *   - deleteToolConfigField (removes field, prunes empty bucket)
 *
 * Also covers the round-trip through `update()` to verify the latent bug —
 * generic field updates nuking the encrypted credential blob — stays fixed.
 */

import type { UserID } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect } from 'vitest';
import { select, update } from '../database-wrapper';
import { users } from '../schema';
import { dbTest } from '../test-helpers';
import { UsersRepository } from './users';

// Force real AES encryption for these tests so non-secret values that contain
// `:` (URLs, ports) round-trip correctly. The dev-mode fallback in
// decryptApiKey treats any `:`-containing string as encrypted format and
// rejects it — fine for prod (master secret is always set), but breaks
// fixtures that store URLs in plaintext mode.
beforeAll(() => {
  if (!process.env.AGOR_MASTER_SECRET) {
    process.env.AGOR_MASTER_SECRET = 'test-master-secret-users-repo';
  }
});

async function makeUser(repo: UsersRepository): Promise<UserID> {
  const u = await repo.create({
    email: `users-test-${Date.now()}-${Math.random()}@example.com`,
    name: 'Users Test',
  });
  return u.user_id as UserID;
}

describe('UsersRepository.setToolConfigField + getToolConfigField', () => {
  dbTest('persists and decrypts a single field', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'secret-key');
    const got = await repo.getToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');
    expect(got).toBe('secret-key');
  });

  dbTest('returns null for unset fields', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);
    const got = await repo.getToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');
    expect(got).toBeNull();
  });

  dbTest('updates the same field idempotently (last write wins)', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'first');
    await repo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'second');

    const got = await repo.getToolConfigField(userId, 'codex', 'OPENAI_API_KEY');
    expect(got).toBe('second');
  });

  dbTest('non-secret fields (e.g. ANTHROPIC_BASE_URL) round-trip too', async ({ db }) => {
    // Storage shape is uniform — text vs password is a UI concern, not a
    // storage one. The base URL goes through the same encrypt/decrypt path.
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(
      userId,
      'claude-code',
      'ANTHROPIC_BASE_URL',
      'https://gateway.example.com'
    );
    const got = await repo.getToolConfigField(userId, 'claude-code', 'ANTHROPIC_BASE_URL');
    expect(got).toBe('https://gateway.example.com');
  });
});

describe('UsersRepository.getToolConfig', () => {
  dbTest('returns null when tool has no fields', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);
    const cfg = await repo.getToolConfig(userId, 'claude-code');
    expect(cfg).toBeNull();
  });

  dbTest('returns all decrypted fields for a single tool', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'k');
    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_BASE_URL', 'https://u');

    const cfg = await repo.getToolConfig(userId, 'claude-code');
    expect(cfg).toEqual({
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://u',
    });
  });

  dbTest('does not return other tools fields', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'a');
    await repo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'o');

    const cc = await repo.getToolConfig(userId, 'claude-code');
    const cx = await repo.getToolConfig(userId, 'codex');
    expect(cc).toEqual({ ANTHROPIC_API_KEY: 'a' });
    expect(cx).toEqual({ OPENAI_API_KEY: 'o' });
  });
});

describe('UsersRepository.deleteToolConfigField', () => {
  dbTest('removes a single field and leaves siblings intact', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'k');
    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_BASE_URL', 'https://u');

    await repo.deleteToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');

    const cfg = await repo.getToolConfig(userId, 'claude-code');
    expect(cfg).toEqual({ ANTHROPIC_BASE_URL: 'https://u' });
  });

  dbTest('prunes the bucket when the last field is removed', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'o');
    await repo.deleteToolConfigField(userId, 'codex', 'OPENAI_API_KEY');

    const cfg = await repo.getToolConfig(userId, 'codex');
    expect(cfg).toBeNull();

    // The DTO presence flags should also reflect the empty state.
    const user = await repo.findById(userId);
    expect(user?.agentic_tools?.codex).toBeUndefined();
  });

  dbTest('is a no-op when the field is not set', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    // Should not throw, even though there's nothing to delete.
    await repo.deleteToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');
    const cfg = await repo.getToolConfig(userId, 'claude-code');
    expect(cfg).toBeNull();
  });
});

describe('UsersRepository agentic_tools DTO projection', () => {
  dbTest('User.agentic_tools exposes only boolean presence flags', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'secret');
    await repo.setToolConfigField(userId, 'gemini', 'GEMINI_API_KEY', 'another');

    const user = await repo.findById(userId);
    expect(user?.agentic_tools).toEqual({
      'claude-code': { ANTHROPIC_API_KEY: true },
      gemini: { GEMINI_API_KEY: true },
    });
  });

  dbTest('omits agentic_tools when no credentials are set', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    const user = await repo.findById(userId);
    expect(user?.agentic_tools).toBeUndefined();
  });
});

describe('UsersRepository.update — credential blob preservation', () => {
  // Regression guard for the latent bug where a generic .update() (e.g.
  // changing the user's name) would round-trip through rowToUser → userToInsert
  // and zero out the encrypted agentic_tools blob because the boolean DTO
  // can't reconstruct the encrypted bytes. The fix threads the raw row into
  // the merge step.
  dbTest('updating an unrelated field preserves stored credentials', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'must-survive');
    await repo.update(userId, { name: 'Renamed User' });

    const stillThere = await repo.getToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');
    expect(stillThere).toBe('must-survive');

    const user = await repo.findById(userId);
    expect(user?.name).toBe('Renamed User');
    expect(user?.agentic_tools?.['claude-code']?.ANTHROPIC_API_KEY).toBe(true);
  });

  // Sibling regression: env_vars lives next to agentic_tools under data.*.
  // The repo doesn't expose a public env_vars mutator (those are managed by
  // the daemon services layer), so we patch the row directly to seed state,
  // then verify a generic .update() round-trip leaves it intact.
  dbTest('updating an unrelated field preserves stored env_vars', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    const seedEnvVars = {
      GITHUB_TOKEN: { value_encrypted: 'enc-gh-token', scope: 'global' },
    };
    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    const currentData = (row?.data ?? {}) as Record<string, unknown>;
    await update(db, users)
      .set({ data: { ...currentData, env_vars: seedEnvVars } })
      .where(eq(users.user_id, userId))
      .run();

    await repo.update(userId, { name: 'Renamed User' });

    const after = await select(db).from(users).where(eq(users.user_id, userId)).one();
    const afterData = (after?.data ?? {}) as { env_vars?: typeof seedEnvVars };
    expect(afterData.env_vars).toEqual(seedEnvVars);
  });
});
