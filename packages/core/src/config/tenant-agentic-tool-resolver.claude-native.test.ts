import { beforeAll, describe, expect } from 'vitest';
import type { Database } from '../db/client';
import { encryptApiKey } from '../db/encryption';
import { UsersRepository, type UsersRepositoryCreate } from '../db/repositories/users';
import { dbTest } from '../db/test-helpers';
import type { ClaudeCredentialSource, StoredAgenticTools } from '../types';
import { resolveProviderConnection } from './tenant-agentic-tool-resolver';

/**
 * The in-app Claude OAuth sign-in stores no token — it writes a daemon-managed
 * ~/.claude/.credentials.json. The resolver must route such a user to NATIVE
 * on-disk auth (no env injection), while a user who pasted a
 * CLAUDE_CODE_OAUTH_TOKEN keeps the env path unchanged (no regression).
 */
beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'claude-native-resolver-test-secret';
});

async function seedUser(
  db: Database,
  opts: {
    method?: 'subscription' | 'api_key';
    source?: ClaudeCredentialSource;
    tools?: StoredAgenticTools;
  }
) {
  // `agentic_tools_raw` is consumed by the repository's insert mapper but isn't
  // on the public create DTO; widen the input so the encrypted blob flows through.
  const input: UsersRepositoryCreate & { agentic_tools_raw?: StoredAgenticTools } = {
    email: `${Math.random().toString(36).slice(2)}@example.com`,
    name: 'resolver-test',
    agentic_tools_raw: opts.tools,
    agentic_auth_methods: opts.method ? { 'claude-code': opts.method } : undefined,
    agentic_credential_sources: opts.source ? { 'claude-code': opts.source } : undefined,
  };
  const user = await new UsersRepository(db).create(input);
  return user.user_id;
}

const connectionOf = (result: { connection: unknown }) =>
  result.connection as Record<string, string | undefined>;

describe('resolveProviderConnection — claude-code native vs env', () => {
  dbTest('explicit managed-file source → native auth, no env injection', async ({ db }) => {
    const userId = await seedUser(db, { method: 'subscription', source: 'managed_file' });
    const result = await resolveProviderConnection('claude-code', { userId, db });
    expect(result.useNativeAuth).toBe(true);
    expect(result.connection).toEqual({});
  });

  dbTest('pasted CLAUDE_CODE_OAUTH_TOKEN → env path, not native', async ({ db }) => {
    const userId = await seedUser(db, {
      method: 'subscription',
      source: 'subscription_token',
      tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: encryptApiKey('sk-ant-oat01-pasted') } },
    });
    const result = await resolveProviderConnection('claude-code', { userId, db });
    expect(result.useNativeAuth).toBe(false);
    expect(connectionOf(result).CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-pasted');
  });

  dbTest('api_key method with an API key → env path with the key', async ({ db }) => {
    const userId = await seedUser(db, {
      method: 'api_key',
      source: 'api_key',
      tools: { 'claude-code': { ANTHROPIC_API_KEY: encryptApiKey('sk-ant-api-xyz') } },
    });
    const result = await resolveProviderConnection('claude-code', { userId, db });
    expect(result.useNativeAuth).toBe(false);
    expect(connectionOf(result).ANTHROPIC_API_KEY).toBe('sk-ant-api-xyz');
  });

  dbTest('no Claude config at all → nothing resolved', async ({ db }) => {
    const userId = await seedUser(db, {});
    const result = await resolveProviderConnection('claude-code', { userId, db });
    expect(result.useNativeAuth).toBe(false);
    expect(result.source).toBe('none');
  });

  dbTest(
    'legacy empty subscription marker does not infer authority over a native file',
    async ({ db }) => {
      const userId = await seedUser(db, { method: 'subscription' });
      const result = await resolveProviderConnection('claude-code', { userId, db });
      expect(result.useNativeAuth).toBe(false);
      expect(result.source).toBe('none');
    }
  );

  dbTest('explicit none keeps both stored credential families dormant', async ({ db }) => {
    const userId = await seedUser(db, {
      method: 'subscription',
      source: 'none',
      tools: {
        'claude-code': {
          ANTHROPIC_API_KEY: encryptApiKey('sk-ant-api-dormant'),
          CLAUDE_CODE_OAUTH_TOKEN: encryptApiKey('sk-ant-oat01-dormant'),
        },
      },
    });
    const result = await resolveProviderConnection('claude-code', { userId, db });
    expect(result.useNativeAuth).toBe(false);
    expect(result.source).toBe('none');
    expect(result.connection).toEqual({});
  });

  dbTest('explicit source selects only that credential when both are stored', async ({ db }) => {
    const tools = {
      'claude-code': {
        ANTHROPIC_API_KEY: encryptApiKey('sk-ant-api-dormant'),
        CLAUDE_CODE_OAUTH_TOKEN: encryptApiKey('sk-ant-oat01-active'),
      },
    } satisfies StoredAgenticTools;
    const tokenUser = await seedUser(db, {
      method: 'subscription',
      source: 'subscription_token',
      tools,
    });
    const tokenResult = await resolveProviderConnection('claude-code', {
      userId: tokenUser,
      db,
    });
    expect(tokenResult.connection).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-active' });

    const apiUser = await seedUser(db, { method: 'api_key', source: 'api_key', tools });
    const apiResult = await resolveProviderConnection('claude-code', { userId: apiUser, db });
    expect(apiResult.connection).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api-dormant' });
  });

  dbTest(
    'managed-file authority wins defensively even if a stale token remains stored',
    async ({ db }) => {
      const userId = await seedUser(db, {
        method: 'subscription',
        source: 'managed_file',
        tools: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: encryptApiKey('sk-ant-oat01-stale') },
        },
      });
      const result = await resolveProviderConnection('claude-code', { userId, db });
      expect(result.useNativeAuth).toBe(true);
      expect(result.connection).toEqual({});
    }
  );
});
