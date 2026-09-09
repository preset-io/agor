/**
 * Key resolver — per-tool credential scoping tests.
 *
 * Verifies that `resolveApiKey`:
 *   - When `tool` is provided, ONLY consults `data.agentic_tools[tool][keyName]`
 *     (so a Codex executor never picks up an ANTHROPIC_API_KEY stored under
 *     claude-code, and vice versa).
 *   - When `tool` is omitted, infers the owning provider from the field.
 */

import type { UserID } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, vi } from 'vitest';
import * as wrapper from '../db/database-wrapper';
import { select, update } from '../db/database-wrapper';
import * as encryption from '../db/encryption';
import { encryptApiKey } from '../db/encryption';
import { TenantAgenticToolSettingsRepository } from '../db/repositories/tenant-agentic-tools';
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

async function createUserWithToolCreds(
  db: any,
  agenticTools: Record<string, Record<string, string>>,
  agenticAuthMethods?: Record<string, string>
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
    .set({
      data: {
        ...currentData,
        agentic_tools: agenticTools,
        agentic_auth_methods: agenticAuthMethods,
      },
    })
    .where(eq(users.user_id, user.user_id))
    .run();
  return user.user_id;
}

afterEach(() => vi.restoreAllMocks());

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
    // even though the user has one stored under claude-code. No cross-tool or
    // native/environment fallback is allowed.
    const codexAnthropic = await resolveApiKey('ANTHROPIC_API_KEY', {
      userId,
      db,
      tool: 'codex',
    });
    expect(codexAnthropic.apiKey).toBeUndefined();
    // The complete Codex connection came from the user scope even though the
    // caller requested a field that does not belong to that connection.
    expect(codexAnthropic.source).toBe('user');
    expect(codexAnthropic.useNativeAuth).toBe(false);
  });

  dbTest('omitting tool infers the owning provider', async ({ db }) => {
    const userId = await createUserWithToolCreds(db, {
      'claude-code': { ANTHROPIC_API_KEY: encryptApiKey('claude-key') },
    });

    // No `tool` provided — the field identifies its typed provider bucket.
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

  dbTest('tool=cursor resolves CURSOR_API_KEY from its own bucket', async ({ db }) => {
    const userId = await createUserWithToolCreds(db, {
      cursor: { CURSOR_API_KEY: encryptApiKey('cursor-key') },
      // A nonsense entry under another bucket should never be returned even
      // though a cross-bucket sweep would otherwise pick it up first.
      'claude-code': { CURSOR_API_KEY: encryptApiKey('wrong-bucket') },
    });

    const result = await resolveApiKey('CURSOR_API_KEY', { userId, db, tool: 'cursor' });
    expect(result.apiKey).toBe('cursor-key');
    expect(result.source).toBe('user');
  });

  dbTest('tenant-preferred selects the complete tenant connection atomically', async ({ db }) => {
    const userId = await createUserWithToolCreds(db, {
      codex: {
        OPENAI_API_KEY: encryptApiKey('user-key'),
        OPENAI_BASE_URL: encryptApiKey('https://user.invalid/v1'),
      },
    });
    await new TenantAgenticToolSettingsRepository(db).patch('codex', {
      resolution_policy: 'tenant_preferred',
      connection: {
        OPENAI_API_KEY: 'tenant-key',
        OPENAI_BASE_URL: 'https://tenant.invalid/v1',
      },
    });

    const result = await resolveApiKey('OPENAI_API_KEY', { userId, db, tool: 'codex' });
    expect(result).toMatchObject({
      apiKey: 'tenant-key',
      source: 'tenant',
      connection: {
        OPENAI_API_KEY: 'tenant-key',
        OPENAI_BASE_URL: 'https://tenant.invalid/v1',
      },
    });
  });

  dbTest('required policies fail closed instead of using the other scope', async ({ db }) => {
    const userId = await createUserWithToolCreds(db, {
      codex: { OPENAI_API_KEY: encryptApiKey('user-key') },
    });
    const repository = new TenantAgenticToolSettingsRepository(db);
    await repository.patch('codex', { resolution_policy: 'tenant_required' });
    await expect(
      resolveApiKey('OPENAI_API_KEY', { userId, db, tool: 'codex' })
    ).resolves.toMatchObject({
      apiKey: undefined,
      source: 'none',
    });

    await repository.patch('codex', {
      resolution_policy: 'user_required',
      connection: { OPENAI_API_KEY: 'tenant-key' },
    });
    const noUser = await resolveApiKey('OPENAI_API_KEY', { db, tool: 'codex' });
    expect(noUser).toMatchObject({ apiKey: undefined, source: 'none' });
  });

  dbTest(
    'Codex subscription is available only after the user explicitly selects it',
    async ({ db }) => {
      const userId = await createUserWithToolCreds(db, {}, { codex: 'subscription' });
      const result = await resolveApiKey('OPENAI_API_KEY', { userId, db, tool: 'codex' });
      expect(result).toMatchObject({
        apiKey: undefined,
        source: 'user',
        useNativeAuth: true,
        connection: {},
      });
    }
  );

  dbTest(
    'Claude authentication method selects one credential family atomically',
    async ({ db }) => {
      const credentials = {
        'claude-code': {
          ANTHROPIC_API_KEY: encryptApiKey('api-key'),
          CLAUDE_CODE_OAUTH_TOKEN: encryptApiKey('subscription-token'),
        },
      };
      const userId = await createUserWithToolCreds(db, credentials, {
        'claude-code': 'subscription',
      });
      const result = await resolveApiKey('CLAUDE_CODE_OAUTH_TOKEN', {
        userId,
        db,
        tool: 'claude-code',
      });
      expect(result.connection).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' });
      expect(result.apiKey).toBe('subscription-token');
    }
  );
  dbTest(
    'reads tenant settings once and opens selected user fields serially with no cross-user cache',
    async ({ db }) => {
      const userId = await createUserWithToolCreds(db, {
        'claude-code': {
          ANTHROPIC_API_KEY: encryptApiKey('user-key'),
          ANTHROPIC_BASE_URL: encryptApiKey(' https://example.invalid '),
        },
      });
      const other = await createUserWithToolCreds(db, {
        'claude-code': { ANTHROPIC_API_KEY: encryptApiKey('other-key') },
      });
      const settings = new TenantAgenticToolSettingsRepository(db);
      await settings.patch('claude-code', {
        resolution_policy: 'user_required',
        connection: { ANTHROPIC_API_KEY: 'tenant-key' },
      });
      const find = vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'find');
      const selectSpy = vi.spyOn(wrapper, 'select');
      let active = 0;
      let peak = 0;
      const native = encryption.decryptApiKeyAsync;
      const open = vi
        .spyOn(encryption, 'decryptApiKeyAsync')
        .mockImplementation(async (...args) => {
          peak = Math.max(peak, ++active);
          try {
            return await native(...args);
          } finally {
            active--;
          }
        });
      const result = await resolveApiKey('ANTHROPIC_API_KEY', { userId, db, tool: 'claude-code' });
      expect(result.apiKey).toBe('user-key');
      expect(result.connection).toMatchObject({ ANTHROPIC_BASE_URL: 'https://example.invalid' });
      expect(find).toHaveBeenCalledTimes(1);
      expect(selectSpy).toHaveBeenCalledTimes(2); // tenant settings + user, formerly three
      expect(open).toHaveBeenCalledTimes(3); // one tenant document + two user fields
      expect(peak).toBe(1);
      expect(
        (await resolveApiKey('ANTHROPIC_API_KEY', { userId: other, db, tool: 'claude-code' }))
          .apiKey
      ).toBe('other-key');
      await new UsersRepository(db).deleteToolConfigField(
        userId,
        'claude-code',
        'ANTHROPIC_API_KEY'
      );
      expect(
        (await resolveApiKey('ANTHROPIC_API_KEY', { userId, db, tool: 'claude-code' })).apiKey
      ).toBeUndefined();
      await settings.patch('claude-code', {
        resolution_policy: 'tenant_required',
        connection: { ANTHROPIC_API_KEY: 'rotated-tenant-key' },
      });
      expect(
        (await resolveApiKey('ANTHROPIC_API_KEY', { userId, db, tool: 'claude-code' })).apiKey
      ).toBe('rotated-tenant-key');
    }
  );
  dbTest(
    'async decryption failure rejects the entire user connection without falling back',
    async ({ db }) => {
      const userId = await createUserWithToolCreds(db, {
        codex: {
          OPENAI_API_KEY: encryptApiKey('valid-first-field'),
          OPENAI_BASE_URL: 'corrupt-envelope',
        },
      });
      await new TenantAgenticToolSettingsRepository(db).patch('codex', {
        connection: { OPENAI_API_KEY: 'tenant-fallback' },
      });
      expect(await resolveApiKey('OPENAI_API_KEY', { userId, db, tool: 'codex' })).toMatchObject({
        apiKey: undefined,
        connection: {},
        source: 'user',
        decryptionFailed: true,
      });
    }
  );

  dbTest.skipIf(process.env.AGOR_BENCH_PROVIDER_READ !== '1')(
    'benchmarks stored user provider resolution without network probes',
    async ({ db }) => {
      const userId = await createUserWithToolCreds(db, {
        'claude-code': {
          ANTHROPIC_API_KEY: encryptApiKey('user-key'),
          ANTHROPIC_AUTH_TOKEN: encryptApiKey('user-token'),
          ANTHROPIC_BASE_URL: encryptApiKey('https://example.invalid'),
        },
      });
      const native = encryption.decryptApiKeyAsync;
      const samples: Record<string, { elapsedMs: number; maxTickGapMs: number }[]> = {
        sync: [],
        async: [],
      };
      for (let round = 0; round < 4; round++) {
        for (const mode of round % 2 ? ['async', 'sync'] : ['sync', 'async']) {
          const spy = vi
            .spyOn(encryption, 'decryptApiKeyAsync')
            .mockImplementation(
              mode === 'sync' ? async (...args) => encryption.decryptApiKey(...args) : native
            );
          let last = performance.now();
          let maxTickGapMs = 0;
          const tick = () => {
            const now = performance.now();
            maxTickGapMs = Math.max(maxTickGapMs, now - last);
            last = now;
          };
          const timer = setInterval(tick, 5);
          try {
            const start = performance.now();
            const result = await resolveApiKey('ANTHROPIC_API_KEY', {
              userId,
              db,
              tool: 'claude-code',
            });
            const elapsedMs = performance.now() - start;
            tick();
            expect(result.apiKey).toBe('user-key');
            if (round) samples[mode].push({ elapsedMs, maxTickGapMs });
          } finally {
            clearInterval(timer);
            spy.mockRestore();
          }
        }
      }
      process.stdout.write(
        `Provider resolution, real SQLite + 3 user fields (1 warmup, 3 samples): ${JSON.stringify(samples)}\n`
      );
    }
  );
});
