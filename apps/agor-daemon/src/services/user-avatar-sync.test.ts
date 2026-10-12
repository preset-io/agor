import { setImmediate as nextTurn } from 'node:timers/promises';
import type { AgorConfig } from '@agor/core/config';
import {
  generateId,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  runWithTenantContext,
  runWithTenantDatabaseTransaction,
  UsersRepository,
} from '@agor/core/db';
import { SlackConnector } from '@agor/core/gateway';
import type { TenantID } from '@agor/core/types';
import { afterEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { avatarTestApp, seedAvatarTenant } from './user-avatar-sync.test-fixtures.js';

process.env.AGOR_MASTER_SECRET ||= 'avatar-fixture-master-secret';
const tenantId = 'avatar-tenant-a' as TenantID;
const config: AgorConfig = {
  database: { dialect: 'sqlite' },
  multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
  execution: { unix_user_mode: 'simple' },
};
const profile = {
  slackUserId: 'U_AVATAR',
  email: 'avatar@example.test',
  displayName: 'Avatar',
  avatarUrl: 'https://example.test/avatar.png',
};

describe('Slack avatar synchronization boundaries', () => {
  afterEach(() => vi.restoreAllMocks());

  dbTest(
    'manual sync uses fresh tenant reads without a database scope across Slack I/O',
    async ({ db }) => {
      const fixture = await seedAvatarTenant(db, tenantId);
      const { service } = avatarTestApp(db, config, true);
      const lookup = vi
        .spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail')
        .mockImplementation(async () => {
          expect(getCurrentTenantId()).toBe(tenantId);
          expect(getCurrentTenantDatabaseScope()).toBeUndefined();
          return profile;
        });
      const result = await service.syncAvatars(
        { gateway_channel_id: fixture.channel.id },
        fixture.params
      );
      expect(result.failures).toEqual([]);
      expect(result).toMatchObject({ ok: true, updated: 1, failed: 0 });
      expect(lookup).toHaveBeenCalledOnce();
      // A second replica has no local listener/cache, but reads the same durable result.
      const replica = avatarTestApp(db, config, true).service;
      expect(await replica.getAvatarSettings({}, fixture.params)).toMatchObject({
        last_sync_result: result,
      });
      expect(await replica.get(fixture.user.user_id, fixture.params)).toMatchObject({
        avatar_url: profile.avatarUrl,
        avatar_source: 'slack',
      });
    }
  );

  dbTest(
    'preserves static-tenant defaults, user opt-out, and manual avatars on disable',
    async ({ db }) => {
      const fixture = await seedAvatarTenant(db, tenantId);
      const manual = await new UsersRepository(db).create({
        user_id: generateId(),
        email: 'opt-out@example.test',
        name: 'Opted out',
        role: 'member',
        avatar_url: 'https://example.test/manual.png',
        avatar_source: 'manual',
        preferences: { use_slack_avatar: false },
      });
      const { service } = avatarTestApp(db, {
        ...config,
        multi_tenancy: { mode: 'static', static_tenant_id: tenantId },
      });
      const lookup = vi
        .spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail')
        .mockResolvedValue(profile);
      expect(await service.getAvatarSettings({}, fixture.params)).toMatchObject({ enabled: false });
      await expect(
        runWithTenantContext(tenantId, () =>
          service.refreshAvatarFromSettings(fixture.user.user_id)
        )
      ).resolves.toBeNull();
      expect(lookup).not.toHaveBeenCalled();
      expect(
        await service.syncAvatars({ gateway_channel_id: fixture.channel.id }, fixture.params)
      ).toMatchObject({ updated: 1, skipped: 1, failed: 0 });
      await service.updateAvatarSettings({ enabled: false }, fixture.params);
      expect((await service.get(fixture.user.user_id, fixture.params)).avatar_url).toBeUndefined();
      expect(await service.get(manual.user_id, fixture.params)).toMatchObject({
        avatar_url: manual.avatar_url,
        avatar_source: 'manual',
      });
      expect(lookup).toHaveBeenCalledOnce();
    }
  );

  for (const avatarAuthority of ['internal', 'external'] as const) {
    dbTest(
      `external accounts permit Slack sync only with internal avatar authority (${avatarAuthority})`,
      async ({ db }) => {
        const fixture = await seedAvatarTenant(db, tenantId);
        const { service } = avatarTestApp(
          db,
          {
            ...config,
            identity: {
              user_lifecycle: 'external',
              role_authority: 'claims',
              local_auth: 'disabled',
              avatar_authority: avatarAuthority,
              external: { provider: 'external_launch', provisioning: 'jit' },
            },
            external_launch: { enabled: true },
          },
          true
        );
        const lookup = vi
          .spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail')
          .mockResolvedValue(profile);
        if (avatarAuthority === 'external') {
          await expect(
            service.updateAvatarSettings(
              { enabled: true, gateway_channel_id: fixture.channel.id },
              fixture.params
            )
          ).rejects.toMatchObject({ code: 403 });
          await expect(
            service.syncAvatars({ gateway_channel_id: fixture.channel.id }, fixture.params)
          ).rejects.toMatchObject({ code: 403 });
          await expect(
            runWithTenantContext(tenantId, () =>
              service.refreshAvatarFromSettings(fixture.user.user_id)
            )
          ).resolves.toBeNull();
          expect(lookup).not.toHaveBeenCalled();
          return;
        }
        await service.updateAvatarSettings(
          { enabled: true, provider: 'slack', gateway_channel_id: fixture.channel.id },
          fixture.params
        );
        await expect(service.syncAvatars({}, fixture.params)).resolves.toMatchObject({
          updated: 1,
          failed: 0,
        });
        await expect(
          runWithTenantContext(tenantId, () =>
            service.refreshAvatarFromSettings(fixture.user.user_id)
          )
        ).resolves.toMatchObject({ updated: 1, failed: 0 });
        expect(await service.get(fixture.user.user_id, fixture.params)).toMatchObject({
          avatar_url: profile.avatarUrl,
          avatar_source: 'slack',
        });
        expect(lookup).toHaveBeenCalledTimes(2);
        await service.updateAvatarSettings({ enabled: false }, fixture.params);
        expect(
          (await service.get(fixture.user.user_id, fixture.params)).avatar_url
        ).toBeUndefined();
      }
    );
  }

  dbTest('automatic refresh opens short units from identity-only context', async ({ db }) => {
    const fixture = await seedAvatarTenant(db, tenantId);
    const { service } = avatarTestApp(db, config);
    await service.updateAvatarSettings(
      { enabled: true, provider: 'slack', gateway_channel_id: fixture.channel.id },
      fixture.params
    );
    const lookup = vi
      .spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail')
      .mockResolvedValue(profile);
    await expect(
      runWithTenantContext(tenantId, () => service.refreshAvatarFromSettings(fixture.user.user_id))
    ).resolves.toMatchObject({ updated: 1, failed: 0 });
    expect(lookup).toHaveBeenCalledOnce();
    await expect(service.refreshAvatarFromSettings(fixture.user.user_id)).rejects.toThrow();
    expect(lookup).toHaveBeenCalledOnce();
  });

  for (const method of ['create', 'patch'] as const) {
    dbTest(
      `${method} refresh waits for commit and does not retain the mutation transaction`,
      async ({ db }) => {
        const fixture = await seedAvatarTenant(db, tenantId);
        const { service, db: guardedDb } = avatarTestApp(db, config);
        await service.updateAvatarSettings(
          { enabled: true, provider: 'slack', gateway_channel_id: fixture.channel.id },
          fixture.params
        );
        const refresh = vi.spyOn(service, 'refreshAvatarFromSettings');
        const lookup = vi
          .spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail')
          .mockImplementation(async () => {
            expect(getCurrentTenantDatabaseScope()).toBeUndefined();
            expect(getCurrentTenantId()).toBe(tenantId);
            return profile;
          });
        let userId = fixture.user.user_id;
        await runWithTenantDatabaseTransaction(guardedDb, tenantId, async () => {
          const user =
            method === 'create'
              ? await service.create(
                  { email: 'new-avatar@example.test', password: 'fixture-password-1234' },
                  fixture.params
                )
              : await service.patch(
                  userId,
                  { preferences: { use_slack_avatar: true } },
                  fixture.params
                );
          userId = user.user_id;
          await nextTurn();
          expect(refresh).not.toHaveBeenCalled();
          expect(lookup).not.toHaveBeenCalled();
        });
        await vi.waitFor(async () => {
          expect(await new UsersRepository(db).findById(userId)).toMatchObject({
            avatar_source: 'slack',
          });
        });
        // UsersService.patch re-enters the Feathers method to acquire its lock,
        // so its existing after-hook runs twice. Avatar patches must not recurse.
        expect(refresh).toHaveBeenCalledTimes(method === 'patch' ? 2 : 1);
        await Promise.all(refresh.mock.results.map((result) => result.value));
        expect(lookup).toHaveBeenCalledTimes(method === 'patch' ? 2 : 1);
      }
    );
  }

  dbTest('a rolled-back user mutation never starts a Slack refresh', async ({ db }) => {
    const fixture = await seedAvatarTenant(db, tenantId);
    const { service, db: guardedDb } = avatarTestApp(db, config);
    const refresh = vi.spyOn(service, 'refreshAvatarFromSettings');
    await expect(
      runWithTenantDatabaseTransaction(guardedDb, tenantId, async () => {
        await service.patch(
          fixture.user.user_id,
          { email: 'rollback@example.test' },
          fixture.params
        );
        throw new Error('fixture rollback');
      })
    ).rejects.toThrow('fixture rollback');
    await nextTurn();
    expect(refresh).not.toHaveBeenCalled();
  });

  dbTest(
    'rejects a conflicting tenant before reading settings or calling Slack',
    async ({ db }) => {
      const fixture = await seedAvatarTenant(db, tenantId);
      const { service } = avatarTestApp(db, config);
      const lookup = vi.spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail');
      await expect(
        runWithTenantContext('avatar-tenant-b', () =>
          service.syncAvatars({ gateway_channel_id: fixture.channel.id }, fixture.params)
        )
      ).rejects.toThrow();
      expect(lookup).not.toHaveBeenCalled();
    }
  );
});
