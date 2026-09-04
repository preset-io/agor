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
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, vi } from 'vitest';
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('UsersRepository password boundary', () => {
  dbTest('rejects plaintext and pre-hashed credential smuggling', async ({ db }) => {
    const repo = new UsersRepository(db);
    await expect(
      repo.create({ email: 'plaintext-smuggle@example.com', password: 'not-a-hash' } as never)
    ).rejects.toThrow(/does not accept password credential fields/);
    await expect(
      repo.create({
        email: 'hash-smuggle@example.com',
        password_hash: await bcrypt.hash('smuggled password', 10),
      } as never)
    ).rejects.toThrow(/does not accept password credential fields/);

    const id = await makeUser(repo);
    await expect(repo.update(id, { password: 'field-smuggle' } as never)).rejects.toThrow(
      /credential fields/
    );
    await expect(repo.update(id, { password_hash: 'field-smuggle' } as never)).rejects.toThrow(
      /credential fields/
    );
    await expect(repo.update(id, { credential_generation: 99 } as never)).rejects.toThrow(
      /credential fields/
    );
    await expect(repo.update(id, { tokens_valid_after: new Date(0) } as never)).rejects.toThrow(
      /credential fields/
    );
  });

  dbTest('preserves an opaque fixture hash during unrelated updates', async ({ db }) => {
    const repo = new UsersRepository(db);
    const fixturePassword = 'fixture-password-long-enough';
    const password_hash = await bcrypt.hash(fixturePassword, 10);
    const user = await repo.create({ email: 'opaque-fixture@example.com' });
    await update(db, users)
      .set({ password: password_hash })
      .where(eq(users.user_id, user.user_id))
      .run();

    await repo.update(user.user_id, { name: 'Updated fixture' });
    const row = await select(db).from(users).where(eq(users.user_id, user.user_id)).one();
    expect(row?.password).toBe(password_hash);
    expect(row && (await bcrypt.compare(fixturePassword, row.password))).toBe(true);
  });
});

describe('UsersRepository execution home key validation', () => {
  dbTest('rejects invalid keys on create and update', async ({ db }) => {
    const repo = new UsersRepository(db);
    await expect(
      repo.create({ email: 'invalid-home-create@example.com', unix_username: '1alice' })
    ).rejects.toThrow(/Invalid execution home key/);

    const id = await makeUser(repo);
    await expect(repo.update(id, { unix_username: '-alice' })).rejects.toThrow(
      /Invalid execution home key/
    );
  });
});

describe('UsersRepository.getFilesystemHomeProjection', () => {
  dbTest('returns only the nonsecret filesystem-home authority fields', async ({ db }) => {
    const repo = new UsersRepository(db);
    const user = await repo.create({
      email: `filesystem-home-${Date.now()}-${Math.random()}@example.com`,
      filesystem_home: '/home/filesystem-owner',
    });
    await repo.setToolConfigField(user.user_id, 'codex', 'OPENAI_API_KEY', 'encrypted-secret');

    await expect(repo.getFilesystemHomeProjection(user.user_id)).resolves.toEqual({
      user_id: user.user_id,
      filesystem_home: '/home/filesystem-owner',
    });
    await expect(
      repo.getFilesystemHomeProjection('00000000-0000-0000-0000-000000000000')
    ).resolves.toBeNull();
  });
});

describe('UsersRepository.findByEmailForAlignment', () => {
  dbTest('matches external-provider emails case-insensitively', async ({ db }) => {
    const repo = new UsersRepository(db);
    const suffix = `${Date.now()}-${Math.random()}`;
    const created = await repo.create({
      email: `Mixed.Case-${suffix}@Example.com`,
      name: 'Mixed Case User',
    });

    const found = await repo.findByEmailForAlignment(`mixed.case-${suffix}@example.com`);

    expect(found?.user_id).toBe(created.user_id);
  });

  dbTest('prefers exact lowercase match when case variants exist', async ({ db }) => {
    const repo = new UsersRepository(db);
    const suffix = `${Date.now()}-${Math.random()}`;
    const lower = await repo.create({
      email: `case-pref-${suffix}@example.com`,
      name: 'Lowercase User',
    });
    await repo.create({
      email: `CASE-PREF-${suffix}@example.com`,
      name: 'Uppercase User',
    });

    const found = await repo.findByEmailForAlignment(`case-pref-${suffix}@example.com`);

    expect(found?.user_id).toBe(lower.user_id);
  });

  dbTest('does not guess when only ambiguous case variants exist', async ({ db }) => {
    const repo = new UsersRepository(db);
    const suffix = `${Date.now()}-${Math.random()}`;
    await repo.create({
      email: `Ambiguous-${suffix}@example.com`,
      name: 'Ambiguous User 1',
    });
    await repo.create({
      email: `AMBIGUOUS-${suffix}@example.com`,
      name: 'Ambiguous User 2',
    });

    const found = await repo.findByEmailForAlignment(`ambiguous-${suffix}@example.com`);

    expect(found).toBeNull();
  });
});

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

  dbTest('writes only supplied fields and preserves opaque concurrent data', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);
    const readSnapshot = deferred();
    const releaseUpdate = deferred();
    const findById = repo.findById.bind(repo);
    vi.spyOn(repo, 'findById').mockImplementation(async (id) => {
      const snapshot = await findById(id);
      readSnapshot.resolve();
      await releaseUpdate.promise;
      return snapshot;
    });

    const profileUpdate = repo.update(userId, { name: 'Only this field changes' });
    await readSnapshot.promise;
    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    const externalIdentities = [
      {
        key: 'external-key',
        provider: 'test-provider',
        issuer: 'https://issuer.example.test',
        subject: 'subject-1',
        last_login_at: new Date().toISOString(),
      },
    ];
    try {
      await update(db, users)
        .set({
          role: 'admin',
          must_change_password: true,
          data: {
            ...row?.data,
            external_identities: externalIdentities,
            future_opaque_field: { preserved: true },
          },
        })
        .where(eq(users.user_id, userId))
        .run();
    } finally {
      releaseUpdate.resolve();
    }
    await profileUpdate;

    const after = await select(db).from(users).where(eq(users.user_id, userId)).one();
    expect(after).toMatchObject({
      name: 'Only this field changes',
      role: 'admin',
      must_change_password: true,
    });
    const afterData = (after?.data ?? {}) as Record<string, unknown>;
    expect(afterData.external_identities).toEqual(externalIdentities);
    expect(afterData.future_opaque_field).toEqual({
      preserved: true,
    });
  });
});
