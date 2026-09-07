import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  GatewayChannelRepository,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import { type GatewayConnector, getConnector } from '@agor/core/gateway';
import {
  DEFAULT_DISCORD_CATCH_UP,
  type GatewayChannel,
  type GatewayConnectionTestResult,
  type TenantID,
} from '@agor/core/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayChannelsService } from './gateway-channels.js';
import { createGatewayChannelsAppInfoService } from './gateway-channels-app-info.js';
import { createGatewayChannelsTestService } from './gateway-channels-test.js';

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return { ...actual, getConnector: vi.fn() };
});

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let applicationIdCounter = 0n;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function verifiedResult(applicationId: string): GatewayConnectionTestResult {
  return {
    ok: true,
    bot: { userId: applicationId, name: 'Agor' },
    verifiedInstallationId: applicationId,
    verification: { status: 'verified', warnings: [] },
    failures: [],
    notVerifiable: [],
  };
}

function discordConfig(applicationId: string, guildId: string, token = 'discord-test-token') {
  return {
    bot_token: token,
    application_id: applicationId,
    guild_id: guildId,
    allowed_channel_ids: ['333333333333333333'],
    allowed_user_ids: ['444444444444444444'],
    allowed_role_ids: [],
    message_content_enabled: true,
    thread_mode: 'public_thread_per_summon',
    align_discord_users: false,
    catch_up: { ...DEFAULT_DISCORD_CATCH_UP },
    files: false,
    agent_tools: [],
  };
}

async function seedChannel(db: Database, tenantId: TenantID, enabled = true) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const applicationId = (BigInt('111111111111111111') + applicationIdCounter++).toString();
    const user = await new UsersRepository(scoped).create({
      user_id: generateId(),
      email: `${tenantId}@example.com`,
      name: 'Gateway authority test',
      role: 'admin',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `gateway-authority-${generateId()}`,
      name: 'Gateway authority test',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/gateway-authority.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `gateway-authority-${generateId()}`,
      ref: 'main',
      branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const channel = await new GatewayChannelRepository(scoped).create({
      id: generateId(),
      name: 'Discord authority',
      channel_type: 'discord',
      channel_key: `discord-authority-${generateId()}`,
      enabled,
      target_branch_id: branch.branch_id,
      agor_user_id: user.user_id,
      created_by: user.user_id,
      config: discordConfig(applicationId, '222222222222222222'),
      provider_installation_id: enabled ? applicationId : null,
    });
    return { applicationId, channel, user };
  });
}

function makeService(db: Database) {
  return new GatewayChannelsService(
    createTenantScopedDatabaseProxy(db, {
      requireScope: true,
      label: 'gateway channel authority test',
    })
  );
}

function configureDelayedProbes(probes: Array<Deferred<GatewayConnectionTestResult>>) {
  vi.mocked(getConnector).mockImplementation(
    () =>
      ({
        testConnection: vi.fn(async () => {
          const probe = probes.shift();
          if (!probe) throw new Error('Unexpected Discord probe');
          return probe.promise;
        }),
      }) as never
  );
}

async function readChannel(db: Database, tenantId: TenantID, id: string) {
  return runWithTenantDatabaseScope(db, tenantId, (scoped) =>
    new GatewayChannelRepository(scoped).findById(id)
  );
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'gateway channel authority concurrency (PostgreSQL)',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      process.env.AGOR_MASTER_SECRET ||= 'gateway-channel-authority-postgres-test-secret';
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterAll(async () => {
      await Promise.all([
        (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    it('makes disable win after a delayed verification probe', async () => {
      const tenantId = `gateway-disable-first-${generateId()}` as TenantID;
      const { channel, applicationId } = await seedChannel(dbA, tenantId);
      const probe = deferred<GatewayConnectionTestResult>();
      configureDelayedProbes([probe]);
      const serviceA = makeService(dbA);
      const serviceB = makeService(dbB);

      const verified = runWithTenantContext(tenantId, () =>
        serviceA.patch(channel.id, {
          config: { guild_id: '888888888888888888' },
        })
      );
      await vi.waitFor(() => expect(vi.mocked(getConnector)).toHaveBeenCalledOnce());

      const disabled = await runWithTenantContext(tenantId, () =>
        serviceB.patch(channel.id, { enabled: false })
      );
      expect(disabled).toMatchObject({ enabled: false, provider_installation_id: null });
      probe.resolve(verifiedResult(applicationId));

      await expect(verified).rejects.toThrow('verification became stale');
      const final = await readChannel(dbA, tenantId, channel.id);
      expect(final).toMatchObject({
        enabled: false,
        provider_installation_id: null,
        provider_config_generation: channel.provider_config_generation + 1,
        config: channel.config,
      });
    }, 30_000);

    it('commits verification before a later disable and keeps both authority transitions', async () => {
      const tenantId = `gateway-verified-first-${generateId()}` as TenantID;
      const { channel, applicationId } = await seedChannel(dbA, tenantId);
      const probe = deferred<GatewayConnectionTestResult>();
      configureDelayedProbes([probe]);
      const serviceA = makeService(dbA);
      const serviceB = makeService(dbB);

      const verified = runWithTenantContext(tenantId, () =>
        serviceA.patch(channel.id, {
          config: { guild_id: '888888888888888888' },
        })
      );
      await vi.waitFor(() => expect(vi.mocked(getConnector)).toHaveBeenCalledOnce());
      probe.resolve(verifiedResult(applicationId));
      const verifiedChannel = await verified;
      expect(verifiedChannel).toMatchObject({
        enabled: true,
        provider_installation_id: applicationId,
        provider_config_generation: channel.provider_config_generation + 1,
        config: { guild_id: '888888888888888888' },
      });

      const disabled = await runWithTenantContext(tenantId, () =>
        serviceB.patch(channel.id, { enabled: false })
      );
      expect(disabled).toMatchObject({
        enabled: false,
        provider_installation_id: null,
        provider_config_generation: channel.provider_config_generation + 2,
        config: { guild_id: '888888888888888888' },
      });
      const final = await readChannel(dbA, tenantId, channel.id);
      expect(final).toMatchObject(disabled);
    }, 30_000);

    it('serializes two nonprobed authority writes and merges each latest row', async () => {
      const tenantId = `gateway-nonprobed-${generateId()}` as TenantID;
      const { channel } = await seedChannel(dbA, tenantId, false);
      const serviceA = makeService(dbA);
      const serviceB = makeService(dbB);

      const [first, second] = await Promise.all([
        runWithTenantContext(tenantId, () =>
          serviceA.patch(channel.id, { config: { guild_id: '888888888888888888' } })
        ),
        runWithTenantContext(tenantId, () =>
          serviceB.patch(channel.id, { config: { allowed_channel_ids: ['999999999999999999'] } })
        ),
      ]);
      const generations = [first, second]
        .map((row) => (row as GatewayChannel).provider_config_generation)
        .sort();
      expect(generations).toEqual([
        channel.provider_config_generation + 1,
        channel.provider_config_generation + 2,
      ]);
      const final = await readChannel(dbA, tenantId, channel.id);
      expect(final).toMatchObject({
        enabled: false,
        provider_installation_id: null,
        provider_config_generation: channel.provider_config_generation + 2,
        config: {
          guild_id: '888888888888888888',
          allowed_channel_ids: ['999999999999999999'],
        },
      });
    }, 30_000);

    it('allows one verified contender and rejects the other with exact CAS', async () => {
      const tenantId = `gateway-verified-contenders-${generateId()}` as TenantID;
      const { channel, applicationId } = await seedChannel(dbA, tenantId);
      const firstProbe = deferred<GatewayConnectionTestResult>();
      const secondProbe = deferred<GatewayConnectionTestResult>();
      configureDelayedProbes([firstProbe, secondProbe]);
      const serviceA = makeService(dbA);
      const serviceB = makeService(dbB);

      const first = runWithTenantContext(tenantId, () =>
        serviceA.patch(channel.id, { config: { guild_id: '888888888888888888' } })
      );
      const second = runWithTenantContext(tenantId, () =>
        serviceB.patch(channel.id, { config: { guild_id: '999999999999999999' } })
      );
      await vi.waitFor(() => expect(vi.mocked(getConnector)).toHaveBeenCalledTimes(2));
      firstProbe.resolve(verifiedResult(applicationId));
      secondProbe.resolve(verifiedResult(applicationId));

      const results = await Promise.allSettled([first, second]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const winner = results.find(
        (result) => result.status === 'fulfilled'
      ) as PromiseFulfilledResult<GatewayChannel>;
      const final = await readChannel(dbA, tenantId, channel.id);
      expect(final).toMatchObject({
        enabled: true,
        provider_installation_id: applicationId,
        provider_config_generation: channel.provider_config_generation + 1,
        config: winner.value.config,
      });
    }, 30_000);

    it('keeps a sparse nonauthority write while a verified authority write races it', async () => {
      const tenantId = `gateway-sparse-race-${generateId()}` as TenantID;
      const { channel, applicationId } = await seedChannel(dbA, tenantId);
      const probe = deferred<GatewayConnectionTestResult>();
      configureDelayedProbes([probe]);
      const serviceA = makeService(dbA);
      const serviceB = makeService(dbB);

      const verified = runWithTenantContext(tenantId, () =>
        serviceA.patch(channel.id, { config: { guild_id: '888888888888888888' } })
      );
      await vi.waitFor(() => expect(vi.mocked(getConnector)).toHaveBeenCalledOnce());
      const renamed = await runWithTenantContext(tenantId, () =>
        serviceB.patch(channel.id, { name: 'renamed concurrently' })
      );
      expect(renamed.name).toBe('renamed concurrently');
      probe.resolve(verifiedResult(applicationId));
      const committed = await verified;
      expect(committed).toMatchObject({
        name: 'renamed concurrently',
        enabled: true,
        provider_installation_id: applicationId,
        provider_config_generation: channel.provider_config_generation + 1,
        config: { guild_id: '888888888888888888' },
      });
      const final = await readChannel(dbA, tenantId, channel.id);
      expect(final).toMatchObject(committed);
    }, 30_000);

    it('does not disclose another tenant channel through service reads or patches', async () => {
      const ownerTenant = `gateway-owner-tenant-${generateId()}` as TenantID;
      const otherTenant = `gateway-other-tenant-${generateId()}` as TenantID;
      const { channel, applicationId } = await seedChannel(dbA, ownerTenant);
      const serviceB = makeService(dbB);

      const readError = await runWithTenantContext(otherTenant, () =>
        serviceB.get(channel.id)
      ).catch((error) => error);
      const patchError = await runWithTenantContext(otherTenant, () =>
        serviceB.patch(channel.id, { config: { guild_id: '888888888888888888' } })
      ).catch((error) => error);
      expect(String(readError)).toMatch(/not found/i);
      expect(String(patchError)).toMatch(/not found/i);
      expect(String(readError)).not.toContain(applicationId);
      expect(String(patchError)).not.toContain(applicationId);
      expect(await readChannel(dbA, ownerTenant, channel.id)).toMatchObject({
        provider_installation_id: applicationId,
        enabled: true,
      });
    }, 30_000);

    it('scopes both gateway probes to tenant A and does not call a provider for tenant B', async () => {
      const ownerTenant = `gateway-probe-owner-${generateId()}` as TenantID;
      const otherTenant = `gateway-probe-other-${generateId()}` as TenantID;
      const { channel } = await seedChannel(dbA, ownerTenant);
      const guardedDb = createTenantScopedDatabaseProxy(dbB, {
        requireScope: true,
        label: 'gateway probe PostgreSQL database',
      });
      const testService = createGatewayChannelsTestService(guardedDb);
      const appInfoService = createGatewayChannelsAppInfoService(guardedDb);
      const connector = {
        testConnection: vi.fn(async () => ({ ok: true, failures: [], notVerifiable: [] })),
        getAppInfo: vi.fn(async () => ({ appId: 'app-a', teamId: 'team-a' })),
      } as unknown as GatewayConnector;
      vi.mocked(getConnector).mockReturnValue(connector);

      await expect(
        runWithTenantContext(ownerTenant, () =>
          testService.create({ gatewayChannelId: channel.id })
        )
      ).resolves.toMatchObject({ ok: true });
      await expect(
        runWithTenantContext(ownerTenant, () =>
          appInfoService.create({ gatewayChannelId: channel.id })
        )
      ).resolves.toEqual({ appId: 'app-a', teamId: 'team-a' });
      expect(connector.testConnection).toHaveBeenCalledOnce();
      expect(connector.getAppInfo).toHaveBeenCalledOnce();

      vi.mocked(getConnector).mockClear();
      const foreignTestError = await runWithTenantContext(otherTenant, () =>
        testService.create({ gatewayChannelId: channel.id })
      ).catch((error) => error);
      const foreignAppInfoError = await runWithTenantContext(otherTenant, () =>
        appInfoService.create({ gatewayChannelId: channel.id })
      ).catch((error) => error);

      expect(String(foreignTestError)).toMatch(/not found/i);
      expect(String(foreignAppInfoError)).toMatch(/not found/i);
      expect(String(foreignTestError)).not.toContain('app-a');
      expect(String(foreignAppInfoError)).not.toContain('app-a');
      expect(vi.mocked(getConnector)).not.toHaveBeenCalled();
    }, 30_000);
  }
);
