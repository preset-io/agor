/**
 * Key resolver — per-tool credential scoping tests.
 *
 * Verifies that `resolveApiKey`:
 *   - When `tool` is provided, ONLY consults `data.agentic_tools[tool][keyName]`
 *     (so a Codex executor never picks up an ANTHROPIC_API_KEY stored under
 *     claude-code, and vice versa).
 *   - When `tool` is omitted, falls back to a cross-bucket sweep (legacy
 *     behavior, preserved for non-SDK callers).
 */

import type { UserID } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect } from 'vitest';
import { select, update } from '../db/database-wrapper';
import { encryptApiKey } from '../db/encryption';
import { UsersRepository } from '../db/repositories/users';
import { users } from '../db/schema';
import { dbTest } from '../db/test-helpers';
import { resolveApiKey } from './key-resolver';

// Force real AES encryption so encrypted values round-trip past the dev-mode
// `:` heuristic in decryptApiKey.
beforeAll(() => {
  if (!process.env.AGOR_MASTER_SECRET) {
    process.env.AGOR_MASTER_SECRET = 'test-master-secret-key-resolver';
  }
});

// biome-ignore lint/suspicious/noExplicitAny: test helper
async function createUserWithToolCreds(
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  db: any,
  agenticTools: Record<string, Record<string, string>>
): Promise<UserID> {
  const usersRepo = new UsersRepository(db);
  const user = await usersRepo.create({
    email: `test-${Date.now()}-${Math.random()}@example.com`,
    name: 'Test',
  });
  const row = await select(db).from(users).where(eq(users.user_id, user.user_id)).one();
  const currentData =
    (row?.data as Record<string, unknown> | undefined) ?? ({} as Record<string, unknown>);
  await update(db, users)
    .set({ data: { ...currentData, agentic_tools: agenticTools } })
    .where(eq(users.user_id, user.user_id))
    .run();
  return user.user_id;
}

describe('resolveApiKey — per-tool credential scoping', () => {
  dbTest('tool-scoped lookup ignores other tools buckets', async ({ db }) => {
    const userId = await createUserWithToolCreds(db, {
      'claude-code': { ANTHROPIC_API_KEY: encryptApiKey('claude-key') },
      codex: { OPENAI_API_KEY: encryptApiKey('codex-key') },
    });

    // Codex asking for OPENAI_API_KEY: scoped to its own bucket → finds it.
    const codexResult = await resolveApiKey('OPENAI_API_KEY', { userId, db, tool: 'codex' });
    expect(codexResult.apiKey).toBe('codex-key');
    expect(codexResult.source).toBe('user');

    // Codex asking for ANTHROPIC_API_KEY: scoped to its own bucket → NOT found
    // even though the user has one stored under claude-code. (Falls through to
    // env/native auth → useNativeAuth=true since no env/config is set in this test.)
    const codexAnthropic = await resolveApiKey('ANTHROPIC_API_KEY', {
      userId,
      db,
      tool: 'codex',
    });
    expect(codexAnthropic.apiKey).toBeUndefined();
    expect(codexAnthropic.source).toBe('none');
    expect(codexAnthropic.useNativeAuth).toBe(true);
  });

  dbTest('omitting tool falls back to cross-bucket sweep (back-compat)', async ({ db }) => {
    const userId = await createUserWithToolCreds(db, {
      'claude-code': { ANTHROPIC_API_KEY: encryptApiKey('claude-key') },
    });

    // No `tool` provided — legacy CLI/non-SDK behavior should still find the key.
    const result = await resolveApiKey('ANTHROPIC_API_KEY', { userId, db });
    expect(result.apiKey).toBe('claude-key');
    expect(result.source).toBe('user');
  });

  dbTest('tool=copilot resolves COPILOT_GITHUB_TOKEN from its own bucket', async ({ db }) => {
    const userId = await createUserWithToolCreds(db, {
      copilot: { COPILOT_GITHUB_TOKEN: encryptApiKey('copilot-key') },
      // A nonsense entry under another bucket should never be returned even
      // though a cross-bucket sweep would otherwise pick it up first.
      'claude-code': { COPILOT_GITHUB_TOKEN: encryptApiKey('wrong-bucket') },
    });

    const result = await resolveApiKey('COPILOT_GITHUB_TOKEN', { userId, db, tool: 'copilot' });
    expect(result.apiKey).toBe('copilot-key');
    expect(result.source).toBe('user');
  });
});
