/**
 * Defence-in-depth tests for UsersService env-var ingest.
 *
 * GITHUB_TOKEN / GH_TOKEN end up interpolated into a clone URL (and at one
 * point into a shell-form git credential helper). Any value that does not
 * match the `isLikelyGitToken` shape must be rejected at ingest so attacker-
 * shaped bytes cannot persist in the database.
 */

import type { AgorConfig } from '@agor/core/config';
import { AgenticToolPresetRepository } from '@agor/core/db';
import type { AuthenticatedParams, Params, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { markLocalAuthenticationLookup, UsersService } from './users';

const externalIdentityConfig: AgorConfig = {
  identity: {
    user_lifecycle: 'external',
    role_authority: 'claims',
    local_auth: 'disabled',
    external: { provider: 'external_launch', provisioning: 'jit' },
  },
  external_launch: { enabled: true },
};

async function makeUser(service: UsersService): Promise<UserID> {
  const user = await service.create({
    email: `sec-${Math.random().toString(36).slice(2)}@test.local`,
    password: 'test-password-1234',
  });
  return user.user_id as UserID;
}

describe('UsersService — git token env var hardening', () => {
  dbTest('rejects GITHUB_TOKEN with shell metacharacters', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc;rm -rf /' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN with newline', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc\nmore' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN with command substitution', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc$(whoami)' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN that is too short', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'short' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GH_TOKEN with the same shape check', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GH_TOKEN: 'abc;id' },
      })
    ).rejects.toThrow(/Invalid GH_TOKEN/);
  });

  dbTest('accepts a well-formed GitHub PAT', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: `ghp_${'a'.repeat(36)}` },
      })
    ).resolves.toBeDefined();
  });
});

describe('UsersService — built-in workload configuration boundary', () => {
  for (const [label, patch] of [
    ['credentials', { agentic_tools: { workload: { API_KEY: 'not-supported' } } }],
    [
      'default configuration',
      {
        default_agentic_config: {
          workload: { modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-test' } },
        },
      },
    ],
    ['default selection', { default_agentic_selection: { workload: { source: 'inline' } } }],
  ] as const) {
    dbTest(`rejects workload ${label}`, async ({ db }) => {
      const service = new UsersService(db);
      const id = await makeUser(service);

      await expect(service.patch(id, patch as never)).rejects.toThrow(
        /does not support user credentials or default configuration/i
      );
      const user = await service.get(id);
      expect(user.agentic_tools?.workload).toBeUndefined();
      expect(user.default_agentic_config?.workload).toBeUndefined();
      expect(user.default_agentic_selection?.workload).toBeUndefined();
    });
  }
});

describe('UsersService — delegated execution home key validation', () => {
  for (const invalid of ['1alice', '-alice', 'Alice', '../alice', 'alice name', 'a'.repeat(33)]) {
    dbTest(`rejects invalid key ${JSON.stringify(invalid)} on create`, async ({ db }) => {
      const service = new UsersService(db);
      await expect(
        service.create({
          email: `invalid-${Math.random().toString(36).slice(2)}@test.local`,
          password: 'test-password-1234',
          unix_username: invalid,
        })
      ).rejects.toThrow(/Execution home key/);
    });

    dbTest(`rejects invalid key ${JSON.stringify(invalid)} on patch`, async ({ db }) => {
      const service = new UsersService(db);
      const id = await makeUser(service);
      await expect(service.patch(id, { unix_username: invalid })).rejects.toThrow(
        /Execution home key/
      );
    });
  }

  dbTest('accepts the canonical delegated key syntax', async ({ db }) => {
    const service = new UsersService(db);
    const user = await service.create({
      email: 'valid-home-key@test.local',
      password: 'test-password-1234',
      unix_username: '_alice-1',
    });
    expect(user.unix_username).toBe('_alice-1');
  });

  dbTest('rejects a duplicate execution-home key across users', async ({ db }) => {
    const service = new UsersService(db);
    await service.create({
      email: 'first-home-key@test.local',
      password: 'test-password-1234',
      unix_username: 'shared-home',
    });
    await expect(
      service.create({
        email: 'second-home-key@test.local',
        password: 'test-password-1234',
        unix_username: 'shared-home',
      })
    ).rejects.toThrow(/already in use/);
  });
});

describe('UsersService — external identity authority', () => {
  dbTest('rejects ordinary create and delete with a stable capability error', async ({ db }) => {
    const local = new UsersService(db);
    const userId = await makeUser(local);
    const external = new UsersService(db, undefined, externalIdentityConfig);

    await expect(
      external.create({ email: 'created-locally@test.local', password: 'test-password-1234' })
    ).rejects.toMatchObject({
      code: 403,
      data: {
        code: 'IDENTITY_EXTERNALLY_MANAGED',
        capability: 'users.create',
        authority: 'external',
      },
    });
    await expect(external.remove(userId)).rejects.toMatchObject({
      code: 403,
      data: {
        code: 'IDENTITY_EXTERNALLY_MANAGED',
        capability: 'users.delete',
        authority: 'external',
      },
    });
  });

  dbTest('rejects claim-owned fields atomically while preserving preferences', async ({ db }) => {
    const local = new UsersService(db);
    const userId = await makeUser(local);
    const external = new UsersService(db, undefined, externalIdentityConfig);

    await expect(
      external.patch(userId, {
        email: 'drift@test.local',
        preferences: { audio: { enabled: false } },
      })
    ).rejects.toMatchObject({
      code: 403,
      data: {
        code: 'IDENTITY_EXTERNALLY_MANAGED',
        capability: 'users.identity.write',
      },
    });

    const unchanged = await external.get(userId);
    expect(unchanged.email).not.toBe('drift@test.local');
    expect(unchanged.preferences).toEqual({});
  });

  dbTest('rejects claim-owned role and password writes', async ({ db }) => {
    const local = new UsersService(db);
    const userId = await makeUser(local);
    const external = new UsersService(db, undefined, externalIdentityConfig);

    await expect(external.patch(userId, { role: 'admin' })).rejects.toMatchObject({
      data: { capability: 'users.role.write', authority: 'claims' },
    });
    await expect(
      external.patch(userId, { password: 'replacement-password' })
    ).rejects.toMatchObject({
      data: { capability: 'users.password.write', authority: 'external' },
    });
  });

  dbTest('keeps Agor-owned settings editable', async ({ db }) => {
    const local = new UsersService(db);
    const userId = await makeUser(local);
    const external = new UsersService(db, undefined, externalIdentityConfig);

    const updated = await external.patch(userId, {
      emoji: '🛠️',
      onboarding_completed: true,
      preferences: { audio: { enabled: false } },
      default_mcp_server_ids: [],
    });

    expect(updated.emoji).toBe('🛠️');
    expect(updated.onboarding_completed).toBe(true);
    expect(updated.preferences).toEqual({ audio: { enabled: false } });
    expect(updated.default_mcp_server_ids).toEqual([]);
  });

  dbTest('persists onboarding deferral without claiming completion', async ({ db }) => {
    const local = new UsersService(db);
    const userId = await makeUser(local);
    const external = new UsersService(db, undefined, externalIdentityConfig);
    const deferredAt = '2026-08-28T23:00:00.000Z';

    const updated = await external.patch(userId, {
      preferences: {
        onboarding: {
          deferredAt,
          goals: ['ship'],
          boardId: 'saved-board',
        },
      },
    });

    expect(updated.onboarding_completed).toBe(false);
    expect(updated.preferences?.onboarding).toMatchObject({
      deferredAt,
      goals: ['ship'],
      boardId: 'saved-board',
    });
  });

  dbTest('composes external capabilities with actor role authority', async ({ db }) => {
    const local = new UsersService(db);
    const superadmin = await local.create({
      email: 'external-superadmin@test.local',
      password: 'test-password-1234',
      role: 'superadmin',
    });
    const member = await local.create({
      email: 'external-member@test.local',
      password: 'test-password-1234',
      role: 'member',
    });
    const params = {
      provider: 'rest',
      user: {
        user_id: superadmin.user_id,
        email: superadmin.email,
        role: superadmin.role,
      },
    } as AuthenticatedParams;
    const external = new UsersService(db, undefined, externalIdentityConfig);

    await expect(
      external.create(
        { email: 'external-created@test.local', password: 'test-password-1234' },
        params
      )
    ).rejects.toMatchObject({ data: { capability: 'users.create' } });
    await expect(
      external.patch(member.user_id as UserID, { role: 'admin' }, params)
    ).rejects.toMatchObject({ data: { capability: 'users.role.write' } });
    await expect(external.remove(member.user_id as UserID, params)).rejects.toMatchObject({
      data: { capability: 'users.delete' },
    });

    await expect(
      external.patch(member.user_id as UserID, { preferences: { theme: 'dark' } }, params)
    ).resolves.toMatchObject({ preferences: { theme: 'dark' } });
  });

  dbTest('disables local password lookup and avatar mutation surfaces', async ({ db }) => {
    const external = new UsersService(db, undefined, externalIdentityConfig);
    const params = { provider: 'rest', query: { email: 'person@test.local' } } as Params;
    markLocalAuthenticationLookup(params);

    await expect(external.find(params)).rejects.toMatchObject({
      code: 401,
      data: { code: 'LOCAL_AUTH_DISABLED' },
    });
    await expect(external.updateAvatarSettings({})).rejects.toMatchObject({
      code: 403,
      data: { capability: 'users.avatar-settings.write' },
    });
    await expect(external.syncAvatars()).rejects.toMatchObject({
      code: 403,
      data: { capability: 'users.avatar-settings.write' },
    });
  });
});

describe('UsersService — avatar source metadata', () => {
  dbTest(
    'marks explicit avatar URL patches as manual and clears Slack metadata',
    async ({ db }) => {
      const service = new UsersService(db);
      const user = await service.create({
        email: 'avatar-source@test.local',
        password: 'test-password-1234',
        avatar_url: 'https://slack.example.com/avatar-512.png',
        avatar_source: 'slack',
        avatar_source_id: 'U123',
        avatar_synced_at: '2026-06-24T00:00:00.000Z',
      });

      const updated = await service.patch(user.user_id as UserID, {
        avatar_url: 'https://cdn.example.com/manual.png',
      });

      expect(updated.avatar_url).toBe('https://cdn.example.com/manual.png');
      expect(updated.avatar_source).toBe('manual');
      expect(updated.avatar_source_id).toBeUndefined();
      expect(updated.avatar_synced_at).toBeUndefined();
    }
  );

  dbTest(
    'clears stale Slack metadata when avatar source changes away from Slack',
    async ({ db }) => {
      const service = new UsersService(db);
      const user = await service.create({
        email: 'avatar-source-change@test.local',
        password: 'test-password-1234',
        avatar_url: 'https://slack.example.com/avatar-512.png',
        avatar_source: 'slack',
        avatar_source_id: 'U456',
        avatar_synced_at: '2026-06-24T00:00:00.000Z',
      });

      const updated = await service.patch(user.user_id as UserID, {
        avatar_url: 'https://launch.example.com/avatar.png',
        avatar_source: 'launch-auth',
      });

      expect(updated.avatar_url).toBe('https://launch.example.com/avatar.png');
      expect(updated.avatar_source).toBe('launch-auth');
      expect(updated.avatar_source_id).toBeUndefined();
      expect(updated.avatar_synced_at).toBeUndefined();
    }
  );
});

describe('UsersService — OpenCode defaults', () => {
  dbTest('rejects an incomplete inline default before persistence', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    await expect(
      service.patch(id, {
        default_agentic_config: {
          opencode: { modelConfig: { mode: 'exact', model: 'gpt-test' } },
        },
        default_agentic_selection: { opencode: { source: 'inline' } },
      })
    ).rejects.toThrow(/provider and model/i);

    expect((await service.get(id)).default_agentic_config?.opencode).toBeUndefined();
  });

  dbTest('rejects unresolved workspace and preset defaults', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    await expect(
      service.patch(id, {
        default_agentic_selection: { opencode: { source: 'workspace_default' } },
      })
    ).rejects.toThrow(/provider and model/i);

    const preset = await new AgenticToolPresetRepository(db).create(
      { tool: 'opencode', name: 'Permissions only', configuration: { permissionMode: 'yolo' } },
      id
    );
    await expect(
      service.patch(id, {
        default_agentic_selection: {
          opencode: { source: 'preset', preset_id: preset.preset_id },
        },
      })
    ).rejects.toThrow(/provider and model/i);

    expect((await service.get(id)).default_agentic_selection?.opencode).toBeUndefined();
  });

  dbTest('persists a complete exact inline pair', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    const updated = await service.patch(id, {
      default_agentic_config: {
        opencode: {
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
        },
      },
      default_agentic_selection: { opencode: { source: 'inline' } },
    });

    expect(updated.default_agentic_config?.opencode?.modelConfig).toMatchObject({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-test',
    });
  });

  dbTest('validates removals against the complete replacement state', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await service.patch(id, {
      default_agentic_config: {
        opencode: {
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
        },
      },
      default_agentic_selection: { opencode: { source: 'inline' } },
    });

    await expect(service.patch(id, { default_agentic_config: {} })).rejects.toThrow(
      /provider and model/i
    );
    expect((await service.get(id)).default_agentic_config?.opencode?.modelConfig).toMatchObject({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-test',
    });
  });

  dbTest('normalizes a provider/model alias to an exact durable pair', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);

    const updated = await service.patch(id, {
      default_agentic_config: {
        opencode: {
          modelConfig: { mode: 'alias', provider: 'openai', model: 'gpt-test' },
        },
      },
      default_agentic_selection: { opencode: { source: 'inline' } },
    });

    expect(updated.default_agentic_config?.opencode?.modelConfig).toMatchObject({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-test',
    });
  });
});
