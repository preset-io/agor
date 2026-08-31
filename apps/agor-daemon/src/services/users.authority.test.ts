import { BoardRepository, UsersRepository } from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { AuthenticatedParams, Params, User, UserID, UserRole } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { markTrustedUserMutation } from './user-mutation-trust';
import { createUsersService, UsersService } from './users';

async function createUser(service: UsersService, role: UserRole, label: string): Promise<User> {
  return service.create({
    email: `${label}-${Math.random().toString(36).slice(2)}@example.test`,
    password: 'test-password-1234',
    name: label,
    role,
  });
}

function externalParams(actor: User, provider = 'rest'): AuthenticatedParams {
  return {
    provider,
    user: {
      user_id: actor.user_id,
      email: actor.email,
      role: actor.role,
    },
  };
}

describe('UsersService role authority', () => {
  for (const provider of ['rest', 'socketio', 'mcp']) {
    dbTest(`denies ${provider} admins every mutation against a superadmin`, async ({ db }) => {
      const service = new UsersService(db);
      const superadmin = await createUser(service, 'superadmin', `superadmin-${provider}`);
      const admin = await createUser(service, 'admin', `admin-${provider}`);
      const params = externalParams(admin, provider);
      await expect(
        service.create(
          {
            email: `created-superadmin-${provider}@example.test`,
            password: 'test-password-1234',
            role: 'superadmin',
          },
          params
        )
      ).rejects.toMatchObject({ code: 403 });
      const forbiddenPatches = [
        { name: 'renamed' },
        { email: `changed-${provider}@example.test` },
        { role: 'member' as const },
        { password: 'replaced-password' },
        { unix_username: 'changed-home' },
        { filesystem_home: '/tmp/changed-home' },
        { must_change_password: true },
        { preferences: { changed: true } },
        { agentic_tools: { codex: { OPENAI_API_KEY: 'secret-key' } } },
        { env_vars: { SECRET: 'secret-value' } },
      ];

      for (const patch of forbiddenPatches) {
        await expect(
          service.patch(superadmin.user_id as UserID, patch, params)
        ).rejects.toMatchObject({ code: 403 });
      }
      await expect(service.remove(superadmin.user_id as UserID, params)).rejects.toMatchObject({
        code: 403,
      });
    });
  }

  dbTest('enforces the actor role ceiling on create and patch', async ({ db }) => {
    const service = new UsersService(db);
    const admin = await createUser(service, 'admin', 'admin');
    const member = await createUser(service, 'member', 'member');

    await expect(
      service.create(
        {
          email: 'created-superadmin@example.test',
          password: 'test-password-1234',
          role: 'superadmin',
        },
        externalParams(admin)
      )
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      service.create(
        {
          email: 'created-owner-alias@example.test',
          password: 'test-password-1234',
          role: 'owner',
        } as never,
        externalParams(admin)
      )
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      service.patch(member.user_id as UserID, { role: 'superadmin' }, externalParams(admin))
    ).rejects.toMatchObject({ code: 403 });

    await expect(
      service.patch(member.user_id as UserID, { role: 'admin' }, externalParams(admin))
    ).resolves.toMatchObject({ role: 'admin' });
  });

  dbTest('allows a superadmin to manage an admin', async ({ db }) => {
    const service = new UsersService(db);
    const superadmin = await createUser(service, 'superadmin', 'superadmin');
    const admin = await createUser(service, 'admin', 'admin');

    await expect(
      service.create(
        {
          email: 'created-admin@example.test',
          password: 'test-password-1234',
          role: 'admin',
        },
        externalParams(superadmin)
      )
    ).resolves.toMatchObject({ role: 'admin' });

    await expect(
      service.patch(
        admin.user_id as UserID,
        { name: 'Managed admin', password: 'reset-password-safe', role: 'member' },
        externalParams(superadmin)
      )
    ).resolves.toMatchObject({ name: 'Managed admin', role: 'member' });
    await expect(
      service.remove(admin.user_id as UserID, externalParams(superadmin))
    ).resolves.toMatchObject({ user_id: admin.user_id });
  });

  dbTest('allows an admin to manage a member', async ({ db }) => {
    const service = new UsersService(db);
    const admin = await createUser(service, 'admin', 'admin');
    const member = await createUser(service, 'member', 'member');

    await expect(
      service.create(
        {
          email: 'created-member@example.test',
          password: 'test-password-1234',
          role: 'member',
        },
        externalParams(admin)
      )
    ).resolves.toMatchObject({ role: 'member' });

    await expect(
      service.patch(
        member.user_id as UserID,
        { name: 'Managed member', password: 'reset-password-safe', must_change_password: true },
        externalParams(admin)
      )
    ).resolves.toMatchObject({ name: 'Managed member', must_change_password: true });
    await expect(
      service.remove(member.user_id as UserID, externalParams(admin))
    ).resolves.toMatchObject({ user_id: member.user_id });
  });

  dbTest(
    'blocks service and raw deletion while the user owns protected resources',
    async ({ db }) => {
      const service = new UsersService(db);
      const admin = await createUser(service, 'admin', 'owner-guard-admin');
      const member = await createUser(service, 'member', 'protected-owner');
      await new BoardRepository(db).create({
        name: 'Protected owner board',
        created_by: member.user_id,
        access_mode: 'private',
      });

      await expect(
        service.remove(member.user_id as UserID, externalParams(admin))
      ).rejects.toMatchObject({ code: 400 });
      await expect(new UsersRepository(db).delete(member.user_id)).rejects.toThrow();
    }
  );

  dbTest('blocks self role changes, self deletion, and last-superadmin removal', async ({ db }) => {
    const service = new UsersService(db);
    const superadmin = await createUser(service, 'superadmin', 'only-superadmin');

    await expect(
      service.patch(superadmin.user_id as UserID, { role: 'admin' }, externalParams(superadmin))
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      service.remove(superadmin.user_id as UserID, externalParams(superadmin))
    ).rejects.toMatchObject({ code: 403 });
    await expect(service.patch(superadmin.user_id as UserID, { role: 'admin' })).rejects.toThrow(
      /last superadmin/i
    );
    await expect(service.remove(superadmin.user_id as UserID)).rejects.toThrow(/last superadmin/i);
  });

  dbTest(
    'allows one superadmin to demote a peer without allowing self-demotion',
    async ({ db }) => {
      const service = new UsersService(db);
      const actor = await createUser(service, 'superadmin', 'actor-superadmin');
      const peer = await createUser(service, 'superadmin', 'peer-superadmin');

      await expect(
        service.patch(peer.user_id as UserID, { role: 'admin' }, externalParams(actor))
      ).resolves.toMatchObject({ role: 'admin' });
      await expect(
        service.patch(actor.user_id as UserID, { role: 'admin' }, externalParams(actor))
      ).rejects.toMatchObject({ code: 403 });
    }
  );

  dbTest('uses fresh database roles instead of stale or forged actor claims', async ({ db }) => {
    const service = new UsersService(db);
    const storedMember = await createUser(service, 'member', 'stale-member');
    const target = await createUser(service, 'member', 'target');
    const forgedParams = externalParams({ ...storedMember, role: 'superadmin' });

    await expect(
      service.patch(target.user_id as UserID, { name: 'forged' }, forgedParams)
    ).rejects.toMatchObject({ code: 403 });
  });

  dbTest('rejects bulk and invalid-role field smuggling', async ({ db }) => {
    const service = new UsersService(db);
    const superadmin = await createUser(service, 'superadmin', 'superadmin');
    const member = await createUser(service, 'member', 'member');

    await expect(
      service.create(
        [
          {
            email: 'bulk@example.test',
            password: 'test-password-1234',
            role: 'superadmin',
          },
        ] as never,
        externalParams(superadmin)
      )
    ).rejects.toMatchObject({ code: 400 });
    await expect(
      service.patch(null as never, { role: 'superadmin' }, externalParams(superadmin))
    ).rejects.toMatchObject({ code: 400 });
    await expect(service.remove(null as never, externalParams(superadmin))).rejects.toMatchObject({
      code: 400,
    });
    await expect(
      service.patch(
        member.user_id as UserID,
        [{ role: 'superadmin' }] as never,
        externalParams(superadmin)
      )
    ).rejects.toMatchObject({ code: 400 });
    await expect(
      service.patch(member.user_id as UserID, { role: 'root' } as never, externalParams(superadmin))
    ).rejects.toMatchObject({ code: 400 });
    await expect(
      service.patch(member.user_id as UserID, { role: 'root' } as never)
    ).rejects.toMatchObject({ code: 400 });
  });

  dbTest('keeps trusted internal mutation purposes narrow', async ({ db }) => {
    const service = new UsersService(db);
    const superadmin = await createUser(service, 'superadmin', 'superadmin');
    const admin = await createUser(service, 'admin', 'admin');

    const avatarParams = {
      user: {
        user_id: 'avatar-service',
        email: 'avatar-service@agor.internal',
        role: 'admin',
        _isServiceAccount: true,
      },
    } as Params;
    markTrustedUserMutation(avatarParams, 'avatar-sync');
    await expect(
      service.patch(
        superadmin.user_id as UserID,
        { avatar_url: 'https://example.test/avatar.png' },
        avatarParams
      )
    ).resolves.toMatchObject({ avatar_url: 'https://example.test/avatar.png' });
    await expect(
      service.patch(superadmin.user_id as UserID, { role: 'member' }, avatarParams)
    ).rejects.toMatchObject({ code: 403 });

    const forgedSelfServiceAccount = {
      user: {
        user_id: superadmin.user_id,
        email: superadmin.email,
        role: 'superadmin',
        _isServiceAccount: true,
      },
    } as Params;
    await expect(
      service.patch(
        superadmin.user_id as UserID,
        { name: 'service-account-smuggling' },
        forgedSelfServiceAccount
      )
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      service.remove(superadmin.user_id as UserID, forgedSelfServiceAccount)
    ).rejects.toMatchObject({ code: 403 });

    const envParams = externalParams(admin) as Params;
    delete envParams.provider;
    markTrustedUserMutation(envParams, 'env-vars-widget');
    await expect(
      service.patch(
        superadmin.user_id as UserID,
        { env_vars: { SECRET: 'replacement' } },
        envParams
      )
    ).rejects.toMatchObject({ code: 403 });
  });

  dbTest('enforces authority after permissive before hooks run', async ({ db }) => {
    const app = feathers();
    app.use('users', createUsersService(db));
    const service = app.service('users');
    const superadmin = await service.create({
      email: 'hook-superadmin@example.test',
      password: 'test-password-1234',
      role: 'superadmin',
    });
    const admin = await service.create({
      email: 'hook-admin@example.test',
      password: 'test-password-1234',
      role: 'admin',
    });
    service.hooks({
      before: {
        patch: [
          (context) => {
            // A stale hook/claim that says superadmin must not outrank the
            // fresh actor row loaded by the service method.
            if (context.params.user) context.params.user.role = 'superadmin';
            return context;
          },
        ],
      },
    });

    await expect(
      service.patch(superadmin.user_id, { name: 'hook bypass' }, externalParams(admin))
    ).rejects.toMatchObject({ code: 403 });
  });
});

describe('UsersService Claude credential-source authority', () => {
  dbTest('serializes source and route changes with managed runtime refresh', async ({ db }) => {
    const runCredentialMutation = vi.fn(
      async <T>(_key: string, work: (generation: number) => Promise<T>) => work(11)
    );
    const service = new UsersService(db, undefined, undefined, {
      runCredentialMutation,
      tombstoneCurrentCredential: vi.fn(async () => undefined),
    });
    const user = await createUser(service, 'admin', 'claude-coordinated-source');
    const params = externalParams(user);

    await service.patch(
      user.user_id as UserID,
      {
        agentic_tools: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-coordinated' },
        },
      },
      params
    );
    await service.patch(
      user.user_id as UserID,
      { filesystem_home: '/tmp/claude-coordinated-home' },
      params
    );
    await service.patch(user.user_id as UserID, { name: 'not-credential-related' }, params);

    expect(runCredentialMutation).toHaveBeenCalledTimes(2);
  });

  dbTest(
    'generation-tombstones the old external home before a route change or user deletion',
    async ({ db }) => {
      const observations: Array<{ tenantId: string; userId: UserID; home: string | null }> = [];
      const mutations = {
        runCredentialMutation: vi.fn(
          async <T>(_key: string, work: (generation: number) => Promise<T>) => work(73)
        ),
        tombstoneCurrentCredential: vi.fn(
          async (input: { tenantId: string; userId: UserID; generation: number }) => {
            const current = await new UsersRepository(db).findById(input.userId);
            observations.push({
              tenantId: input.tenantId,
              userId: input.userId,
              home: current?.filesystem_home ?? null,
            });
            expect(input.generation).toBe(73);
          }
        ),
      };
      const config = {
        execution: {
          unix_user_mode: 'sandbox' as const,
          executor_storage: { user_home: 'persistent-per-user' as const },
          sandbox: { enabled: true, home_mode: 'per_user' as const },
        },
      };
      const service = new UsersService(db, undefined, config, mutations);
      const admin = await createUser(service, 'admin', 'claude-cleanup-admin');
      const moving = await createUser(service, 'member', 'claude-cleanup-moving');
      const deleting = await createUser(service, 'member', 'claude-cleanup-deleting');
      const params = {
        ...externalParams(admin),
        tenant: { tenant_id: 'tenant-a' },
      } as AuthenticatedParams;
      const trusted = { ...params, provider: undefined } as Params;
      markTrustedUserMutation(trusted, 'claude-auth');
      for (const user of [moving, deleting]) {
        await service.patch(
          user.user_id as UserID,
          { filesystem_home: `/srv/old-${user.user_id}` },
          params
        );
        await service.patch(
          user.user_id as UserID,
          {
            agentic_auth_methods: { 'claude-code': 'subscription' },
            agentic_credential_sources: { 'claude-code': 'managed_file' },
          },
          trusted
        );
      }
      await service.patch(
        moving.user_id as UserID,
        { filesystem_home: `/srv/old-${moving.user_id}` },
        params
      );
      await service.patch(moving.user_id as UserID, { unix_username: 'sandbox-home-key' }, params);
      expect(mutations.tombstoneCurrentCredential).not.toHaveBeenCalled();
      await service.patch(moving.user_id as UserID, { filesystem_home: '/srv/new-home' }, params);
      await service.remove(deleting.user_id as UserID, params);

      expect(observations).toEqual([
        {
          tenantId: 'tenant-a',
          userId: moving.user_id,
          home: `/srv/old-${moving.user_id}`,
        },
        {
          tenantId: 'tenant-a',
          userId: deleting.user_id,
          home: `/srv/old-${deleting.user_id}`,
        },
      ]);
      expect(mutations.tombstoneCurrentCredential).toHaveBeenCalledTimes(2);
    }
  );

  dbTest(
    'serializes blocked SQLite cleanup with actor demotion across different target users',
    async ({ db }) => {
      let cleanupEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        cleanupEntered = resolve;
      });
      let releaseCleanup!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const mutations = {
        runCredentialMutation: vi.fn(
          async <T>(_key: string, work: (generation: number) => Promise<T>) => work(91)
        ),
        tombstoneCurrentCredential: vi.fn(async () => {
          cleanupEntered();
          await release;
        }),
      };
      const config = {
        execution: {
          unix_user_mode: 'sandbox' as const,
          executor_storage: { user_home: 'persistent-per-user' as const },
          sandbox: { enabled: true, home_mode: 'per_user' as const },
        },
      };
      const service = new UsersService(db, undefined, config, mutations);
      const superadmin = await createUser(service, 'superadmin', 'cleanup-race-superadmin');
      const admin = await createUser(service, 'admin', 'cleanup-race-admin');
      const member = await createUser(service, 'member', 'cleanup-race-member');
      const tenant = { tenant_id: 'cleanup-race-tenant' };
      const superadminParams = { ...externalParams(superadmin), tenant } as AuthenticatedParams;
      const adminParams = { ...externalParams(admin), tenant } as AuthenticatedParams;
      const trusted = { ...superadminParams, provider: undefined } as Params;
      markTrustedUserMutation(trusted, 'claude-auth');
      await service.patch(
        member.user_id as UserID,
        { filesystem_home: '/srv/cleanup-race-old' },
        superadminParams
      );
      await service.patch(
        member.user_id as UserID,
        {
          agentic_auth_methods: { 'claude-code': 'subscription' },
          agentic_credential_sources: { 'claude-code': 'managed_file' },
        },
        trusted
      );

      const cleanup = service.patch(
        member.user_id as UserID,
        { filesystem_home: '/srv/cleanup-race-new' },
        adminParams
      );
      await entered;
      let demotionSettled = false;
      const demotion = service
        .patch(admin.user_id as UserID, { role: 'member' }, superadminParams)
        .finally(() => {
          demotionSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(demotionSettled).toBe(false);

      releaseCleanup();
      await expect(cleanup).resolves.toMatchObject({ user_id: member.user_id });
      await expect(demotion).resolves.toMatchObject({ role: 'member' });
      await expect(
        new UsersRepository(db).findById(member.user_id as UserID)
      ).resolves.toMatchObject({ filesystem_home: '/srv/cleanup-race-new' });
      expect(mutations.tombstoneCurrentCredential).toHaveBeenCalledTimes(1);
    }
  );

  dbTest(
    'linearizes managed-file → pasted-token → clear without reactivating the file',
    async ({ db }) => {
      const service = new UsersService(db);
      const user = await createUser(service, 'member', 'claude-source');
      const params = externalParams(user);
      const trustedParams = { ...params, provider: undefined } as Params;
      markTrustedUserMutation(trustedParams, 'claude-auth');

      await expect(
        service.patch(
          user.user_id as UserID,
          {
            agentic_auth_methods: { 'claude-code': 'subscription' },
            agentic_credential_sources: { 'claude-code': 'managed_file' },
          },
          trustedParams
        )
      ).resolves.toMatchObject({
        agentic_credential_sources: { 'claude-code': 'managed_file' },
      });

      await expect(
        service.patch(
          user.user_id as UserID,
          {
            agentic_tools: {
              'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-pasted' },
            },
          },
          params
        )
      ).resolves.toMatchObject({
        agentic_auth_methods: { 'claude-code': 'subscription' },
        agentic_credential_sources: { 'claude-code': 'subscription_token' },
        agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: true } },
      });

      // Even an older client that sends only the field clear gets the source
      // transition in the same users-row write.
      await expect(
        service.patch(
          user.user_id as UserID,
          { agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } } },
          params
        )
      ).resolves.toMatchObject({
        agentic_credential_sources: { 'claude-code': 'none' },
        agentic_tools: {},
      });
    }
  );

  dbTest('persists none when an older client clears a legacy source-less token', async ({ db }) => {
    const service = new UsersService(db);
    const user = await createUser(service, 'member', 'claude-legacy-source');
    const params = externalParams(user);

    await service.patch(
      user.user_id as UserID,
      {
        agentic_tools: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-legacy' },
        },
      },
      params
    );
    // Model a row written before exact-source persistence was introduced.
    await new UsersRepository(db).update(user.user_id, { agentic_credential_sources: {} });

    await expect(
      service.patch(
        user.user_id as UserID,
        { agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } } },
        params
      )
    ).resolves.toMatchObject({
      agentic_credential_sources: { 'claude-code': 'none' },
      agentic_tools: {},
    });
  });

  dbTest('keeps inactive credentials dormant across every Claude source switch', async ({ db }) => {
    const service = new UsersService(db);
    const user = await createUser(service, 'member', 'claude-permutations');
    const params = externalParams(user);
    const trustedParams = { ...params, provider: undefined } as Params;
    markTrustedUserMutation(trustedParams, 'claude-auth');

    const api = await service.patch(
      user.user_id as UserID,
      {
        agentic_tools: {
          'claude-code': {
            ANTHROPIC_API_KEY: 'sk-ant-api-test',
            ANTHROPIC_AUTH_TOKEN: 'sk-ant-auth-test',
          },
        },
      },
      params
    );
    expect(api).toMatchObject({
      agentic_auth_methods: { 'claude-code': 'api_key' },
      agentic_credential_sources: { 'claude-code': 'api_key' },
    });

    // Either API credential is sufficient. Clearing one must not deactivate
    // the other credential in the same active source family.
    await expect(
      service.patch(
        user.user_id as UserID,
        { agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: null } } },
        params
      )
    ).resolves.toMatchObject({
      agentic_auth_methods: { 'claude-code': 'api_key' },
      agentic_credential_sources: { 'claude-code': 'api_key' },
      agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: true } },
    });

    const token = await service.patch(
      user.user_id as UserID,
      {
        agentic_tools: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-pasted' },
        },
      },
      params
    );
    expect(token).toMatchObject({
      agentic_credential_sources: { 'claude-code': 'subscription_token' },
      agentic_tools: {
        'claude-code': { ANTHROPIC_AUTH_TOKEN: true, CLAUDE_CODE_OAUTH_TOKEN: true },
      },
    });

    const managed = await service.patch(
      user.user_id as UserID,
      {
        agentic_credential_sources: { 'claude-code': 'managed_file' },
      },
      trustedParams
    );
    expect(managed).toMatchObject({
      agentic_auth_methods: { 'claude-code': 'subscription' },
      agentic_credential_sources: { 'claude-code': 'managed_file' },
      agentic_tools: {
        'claude-code': { ANTHROPIC_AUTH_TOKEN: true, CLAUDE_CODE_OAUTH_TOKEN: true },
      },
    });

    // Clearing a dormant pasted token must not log out the active managed file.
    await expect(
      service.patch(
        user.user_id as UserID,
        { agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } } },
        params
      )
    ).resolves.toMatchObject({
      agentic_auth_methods: { 'claude-code': 'subscription' },
      agentic_credential_sources: { 'claude-code': 'managed_file' },
      agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: true } },
    });

    // Clearing an inactive API credential must not log out the managed file.
    await expect(
      service.patch(
        user.user_id as UserID,
        { agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: null } } },
        params
      )
    ).resolves.toMatchObject({
      agentic_auth_methods: { 'claude-code': 'subscription' },
      agentic_credential_sources: { 'claude-code': 'managed_file' },
    });

    await expect(
      service.patch(
        user.user_id as UserID,
        { agentic_credential_sources: { 'claude-code': 'managed_file' } },
        params
      )
    ).rejects.toMatchObject({ code: 403 });
  });

  dbTest(
    'maps legacy method-only switches and clears onto exact backed sources',
    async ({ db }) => {
      const service = new UsersService(db);
      const user = await createUser(service, 'member', 'claude-method-switch');
      const params = externalParams(user);

      await service.patch(
        user.user_id as UserID,
        { agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: 'sk-ant-api-dormant' } } },
        params
      );
      await service.patch(
        user.user_id as UserID,
        {
          agentic_tools: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-active' },
          },
        },
        params
      );

      await expect(
        service.patch(
          user.user_id as UserID,
          { agentic_auth_methods: { 'claude-code': 'api_key' } },
          params
        )
      ).resolves.toMatchObject({
        agentic_auth_methods: { 'claude-code': 'api_key' },
        agentic_credential_sources: { 'claude-code': 'api_key' },
      });

      await expect(
        service.patch(
          user.user_id as UserID,
          { agentic_auth_methods: { 'claude-code': 'subscription' } },
          params
        )
      ).resolves.toMatchObject({
        agentic_auth_methods: { 'claude-code': 'subscription' },
        agentic_credential_sources: { 'claude-code': 'subscription_token' },
      });

      await expect(
        service.patch(
          user.user_id as UserID,
          { agentic_auth_methods: { 'claude-code': undefined } },
          params
        )
      ).resolves.toMatchObject({
        agentic_credential_sources: { 'claude-code': 'none' },
      });
    }
  );
});
