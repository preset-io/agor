import { compare, createDefaultAdminUser, eq, hash, select, users } from '@agor/core/db';
import type { AuthenticatedParams, User, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

const STRONG_PASSWORD = 'a unique local test passphrase';

function params(actor: User, provider: string): AuthenticatedParams {
  return {
    provider,
    user: { user_id: actor.user_id, email: actor.email, role: actor.role },
  };
}

describe('UsersService password policy', () => {
  dbTest(
    'enforces stable validation codes for every transport and direct-service create',
    async ({ db }) => {
      const service = new UsersService(db);
      const actor = await service.create({
        email: 'password-policy-actor@example.test',
        password: STRONG_PASSWORD,
        role: 'superadmin',
      });

      for (const provider of ['rest', 'socketio', 'mcp']) {
        const candidate = `short-${provider}`;
        await expect(
          service.create(
            {
              email: `weak-${provider}@example.test`,
              password: candidate,
            },
            params(actor, provider)
          )
        ).rejects.toMatchObject({
          code: 400,
          data: {
            code: 'PASSWORD_TOO_SHORT',
            policy: 'secure',
            min_length: 15,
            max_utf8_bytes: 72,
          },
        });
      }

      await expect(
        service.create({ email: 'weak-direct@example.test', password: 'short' })
      ).rejects.toMatchObject({ code: 400, data: { code: 'PASSWORD_TOO_SHORT' } });
    }
  );

  dbTest(
    'rejects empty, undefined, non-string, common, oversized, and hash-field smuggling',
    async ({ db }) => {
      const service = new UsersService(db);
      const user = await service.create({
        email: 'password-smuggling@example.test',
        password: STRONG_PASSWORD,
      });

      const cases: Array<[unknown, string]> = [
        ['', 'PASSWORD_REQUIRED'],
        [undefined, 'PASSWORD_REQUIRED'],
        [123456789012345, 'PASSWORD_REQUIRED'],
        ['password-password', 'PASSWORD_COMMON'],
        ['x'.repeat(73), 'PASSWORD_TOO_LONG'],
      ];
      for (const [password, code] of cases) {
        await expect(
          service.patch(user.user_id as UserID, { password } as never)
        ).rejects.toMatchObject({ code: 400, data: { code } });
      }

      await expect(
        service.patch(
          user.user_id as UserID,
          {
            password_hash: await hash('smuggled weak password', 10),
          } as never
        )
      ).rejects.toMatchObject({
        code: 400,
        data: { code: 'PASSWORD_HASH_NOT_ACCEPTED' },
      });
    }
  );

  dbTest('grandfathers the controlled development admin until assignment', async ({ db }) => {
    const admin = await createDefaultAdminUser(db, { allowDevelopmentDefault: true });
    const service = new UsersService(db);
    const before = await select(db).from(users).where(eq(users.user_id, admin.user_id)).one();
    expect(before && (await compare('admin', before.password))).toBe(true);

    await expect(
      service.patch(admin.user_id as UserID, { password: 'admin' })
    ).rejects.toMatchObject({ code: 400, data: { code: 'PASSWORD_TOO_SHORT' } });

    const after = await select(db).from(users).where(eq(users.user_id, admin.user_id)).one();
    expect(after?.password).toBe(before?.password);
    expect(after && (await compare('admin', after.password))).toBe(true);
  });

  dbTest(
    'accepts a strong assignment and advances the browser-token revocation marker',
    async ({ db }) => {
      const service = new UsersService(db);
      const user = await service.create({
        email: 'password-revocation@example.test',
        password: STRONG_PASSWORD,
        must_change_password: true,
      });

      await service.patch(user.user_id as UserID, {
        password: 'a second unique local passphrase',
      });
      const row = await select(db).from(users).where(eq(users.user_id, user.user_id)).one();
      expect(row?.tokens_valid_after).toBeInstanceOf(Date);
      expect(row?.must_change_password).toBe(false);
      expect(row && (await compare('a second unique local passphrase', row.password))).toBe(true);
    }
  );

  dbTest(
    'keeps external identity errors authoritative and never applies local policy',
    async ({ db }) => {
      const local = new UsersService(db);
      const user = await local.create({
        email: 'external-password-policy@example.test',
        password: STRONG_PASSWORD,
      });
      const external = new UsersService(db, undefined, {
        external_launch: { enabled: true },
        identity: {
          user_lifecycle: 'external',
          role_authority: 'claims',
          local_auth: 'disabled',
          external: { provider: 'external_launch', provisioning: 'jit' },
        },
      });

      await expect(
        external.patch(user.user_id as UserID, { password: 'short' })
      ).rejects.toMatchObject({
        code: 403,
        data: { code: 'IDENTITY_EXTERNALLY_MANAGED', capability: 'users.password.write' },
      });
    }
  );
});
