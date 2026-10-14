import { setImmediate as nextTurn } from 'node:timers/promises';
import type { AgorConfig } from '@agor/core/config';
import {
  acquireTenantWriteGate,
  createDatabase,
  type Database,
  generateId,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  initializeDatabase,
  runWithTenantDatabaseTransaction,
} from '@agor/core/db';
import { SlackConnector } from '@agor/core/gateway';
import type { TenantID } from '@agor/core/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { avatarTestApp, seedAvatarTenant } from './user-avatar-sync.test-fixtures.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const config: AgorConfig = {
  database: { dialect: 'postgresql' },
  multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
  execution: { unix_user_mode: 'simple' },
  identity: {
    user_lifecycle: 'external',
    role_authority: 'claims',
    local_auth: 'disabled',
    avatar_authority: 'internal',
    external: { provider: 'external_launch', provisioning: 'jit' },
  },
  external_launch: { enabled: true },
};

describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'Slack avatar sync PostgreSQL / HA tenant isolation',
  () => {
    let dbA: Database;
    let dbB: Database;
    beforeAll(async () => {
      process.env.AGOR_MASTER_SECRET ||= 'avatar-fixture-master-secret';
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await Promise.all(
        [dbA, dbB].map((db) =>
          (db as Database & { $client: { end(): Promise<void> } }).$client.end()
        )
      );
    });

    it('shares durable settings across replicas but never channels, users, or cleanup across tenants', async () => {
      const a = await seedAvatarTenant(dbA, `avatar-a-${generateId()}` as TenantID);
      const b = await seedAvatarTenant(dbA, `avatar-b-${generateId()}` as TenantID);
      const replicaA = avatarTestApp(dbA, config, true).service;
      const replicaB = avatarTestApp(dbB, config, true).service;
      const lookup = vi
        .spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail')
        .mockImplementation(async (email) => {
          expect(getCurrentTenantDatabaseScope()).toBeUndefined();
          return {
            slackUserId: 'U_AVATAR',
            email,
            displayName: 'Avatar',
            avatarUrl: `https://example.test/${getCurrentTenantId()}.png`,
          };
        });
      await replicaA.updateAvatarSettings(
        { enabled: true, provider: 'slack', gateway_channel_id: a.channel.id },
        a.params
      );
      await expect(replicaB.getAvatarSettings({}, b.params)).resolves.toMatchObject({
        enabled: false,
        gateway_channel_id: null,
      });
      await expect(replicaB.syncAvatars({}, a.params)).resolves.toMatchObject({
        updated: 1,
        failed: 0,
      });
      await expect(
        replicaB.syncAvatars({ gateway_channel_id: b.channel.id }, b.params)
      ).resolves.toMatchObject({ updated: 1, failed: 0 });
      expect(lookup).toHaveBeenCalledTimes(2);

      // Same email in both tenants must not bypass either the gateway or user boundary.
      await expect(
        replicaB.syncAvatars({ gateway_channel_id: a.channel.id }, b.params)
      ).rejects.toThrow('Gateway channel not found');
      await expect(
        replicaB.syncAvatars(
          { gateway_channel_id: b.channel.id, user_id: a.user.user_id },
          b.params
        )
      ).rejects.toThrow('User not found');
      expect(lookup).toHaveBeenCalledTimes(2);
      await expect(replicaB.getAvatarSettings({}, b.params)).resolves.toMatchObject({
        gateway_channel_id: b.channel.id,
      });
      await replicaB.updateAvatarSettings({ enabled: false }, b.params);
      await expect(replicaA.get(a.user.user_id, a.params)).resolves.toMatchObject({
        avatar_url: `https://example.test/${a.tenantId}.png`,
        avatar_source: 'slack',
      });
      expect((await replicaB.get(b.user.user_id, b.params)).avatar_url).toBeUndefined();
    });

    it('refreshes after commit using fresh PostgreSQL scopes, not the closed mutation transaction', async () => {
      const a = await seedAvatarTenant(dbA, `avatar-defer-${generateId()}` as TenantID);
      const { service, db } = avatarTestApp(dbA, config, true);
      const observer = avatarTestApp(dbB, config, true).service;
      const refresh = vi.spyOn(service, 'refreshAvatarFromSettings');
      await service.updateAvatarSettings(
        { enabled: true, provider: 'slack', gateway_channel_id: a.channel.id },
        a.params
      );
      const lookup = vi
        .spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail')
        .mockImplementation(async (email) => {
          expect(getCurrentTenantDatabaseScope()).toBeUndefined();
          expect(getCurrentTenantId()).toBe(a.tenantId);
          // Another connection must already see the authoritative mutation.
          expect(await observer.get(a.user.user_id, a.params)).toMatchObject({
            email,
            preferences: { use_slack_avatar: true },
          });
          return {
            slackUserId: 'U_AVATAR',
            email,
            displayName: 'Avatar',
            avatarUrl: 'https://example.test/committed.png',
          };
        });
      await runWithTenantDatabaseTransaction(db, a.tenantId, async () => {
        // Preferences are Agor-owned even when email/account lifecycle is external.
        await service.patch(a.user.user_id, { preferences: { use_slack_avatar: true } }, a.params);
        await nextTurn();
        expect(lookup).not.toHaveBeenCalled();
      });
      await vi.waitFor(async () => {
        expect(await observer.get(a.user.user_id, a.params)).toMatchObject({
          avatar_url: 'https://example.test/committed.png',
        });
      });
      await Promise.all(refresh.mock.results.map((result) => result.value));
    });

    it('preserves write admission before Slack I/O on the identity-only manual path', async () => {
      const a = await seedAvatarTenant(dbA, `avatar-frozen-${generateId()}` as TenantID);
      const service = avatarTestApp(dbA, config, true).service;
      await acquireTenantWriteGate(dbB, a.tenantId);
      const lookup = vi.spyOn(SlackConnector.prototype, 'lookupUserAvatarByEmail');
      await expect(
        service.syncAvatars({ gateway_channel_id: a.channel.id }, a.params)
      ).rejects.toMatchObject({ code: 503 });
      expect(lookup).not.toHaveBeenCalled();
    });
  }
);
