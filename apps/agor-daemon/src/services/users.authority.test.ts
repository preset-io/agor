import { BoardRepository, UsersRepository } from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { AuthenticatedParams, Params, User, UserID, UserRole } from '@agor/core/types';
import { describe, expect } from 'vitest';
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
