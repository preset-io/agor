import type { GatewayChannelRepository, TenantScopeAwareDatabase } from '@agor/core/db';
import type { GatewayConnector } from '@agor/core/gateway';
import { getConnector } from '@agor/core/gateway';
import type {
  GatewayChannel,
  GatewayChannelID,
  GatewayConnectionTestResult,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from '../adapters/drizzle';
import { GatewayChannelsService } from './gateway-channels';

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return { ...actual, getConnector: vi.fn() };
});

const appId = 'teams-app-id';
const config = {
  app_id: appId,
  app_password: 'client-secret',
  microsoft_tenant_id: 'tenant-guid',
  align_teams_users: true,
};

const draft: GatewayChannel = {
  id: 'teams-channel-1' as GatewayChannelID,
  created_by: 'user-1',
  name: 'Teams',
  channel_type: 'teams',
  target_branch_id: 'branch-1' as GatewayChannel['target_branch_id'],
  agor_user_id: null,
  provider_installation_id: null,
  provider_config_generation: 2,
  channel_key: 'channel-key',
  config,
  agentic_config: null,
  enabled: false,
  created_at: '2026-10-07T00:00:00.000Z',
  updated_at: '2026-10-07T00:00:00.000Z',
  last_message_at: null,
};

function probeResult(ok: boolean): GatewayConnectionTestResult {
  return ok
    ? {
        ok: true,
        verifiedInstallationId: appId,
        verification: { status: 'verified', warnings: [] },
        failures: [],
        notVerifiable: [],
      }
    : {
        ok: false,
        failures: [{ capability: 'app_password', reason: 'The app password is invalid.' }],
        notVerifiable: [],
      };
}

function makeService(current: GatewayChannel = draft) {
  const updateWithVerifiedProviderInstallation = vi.fn(async () => ({
    ...current,
    enabled: true,
    provider_installation_id: appId,
  }));
  const channelRepo = {
    findById: vi.fn(async () => current),
    findDisplayById: vi.fn(async () => current),
    updateWithVerifiedProviderInstallation,
  } as unknown as GatewayChannelRepository;
  const repository = {
    create: vi.fn(async (data: Partial<GatewayChannel>) => ({ ...current, ...data })),
    findById: vi.fn(async () => current),
    update: vi.fn(async (_id: string, data: Partial<GatewayChannel>) => ({ ...current, ...data })),
  } as unknown as Repository<GatewayChannel>;
  const service = new GatewayChannelsService({} as TenantScopeAwareDatabase);
  (service as unknown as { channelRepo: GatewayChannelRepository }).channelRepo = channelRepo;
  (service as unknown as { repository: Repository<GatewayChannel> }).repository = repository;
  return { service, repository, updateWithVerifiedProviderInstallation };
}

function stubProbe(ok: boolean) {
  const testConnection = vi.fn(async () => probeResult(ok));
  vi.mocked(getConnector).mockReturnValue({ testConnection } as unknown as GatewayConnector);
  return testConnection;
}

const createData = {
  name: 'Teams',
  channel_type: 'teams' as const,
  target_branch_id: 'branch-1' as GatewayChannel['target_branch_id'],
  config,
};

describe('GatewayChannelsService Teams credential verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables a new Teams channel on create only with the probed app binding', async () => {
    const { service, repository } = makeService();
    const testConnection = stubProbe(true);
    await service.create(createData);
    expect(testConnection).toHaveBeenCalledOnce();
    expect(vi.mocked(getConnector).mock.calls[0]?.[0]).toBe('teams');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider_installation_id: appId })
    );
  });

  it('refuses to create an enabled Teams channel when the probe fails, but keeps drafts', async () => {
    const { service, repository } = makeService();
    stubProbe(false);
    await expect(service.create(createData)).rejects.toThrow(
      'Teams verification failed: The app password is invalid.'
    );
    expect(repository.create).not.toHaveBeenCalled();

    const testConnection = stubProbe(false);
    await service.create({ ...createData, enabled: false });
    expect(testConnection).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ provider_installation_id: expect.anything() })
    );
  });

  it('cannot smuggle an installation binding through public create input', async () => {
    const { service, repository } = makeService();
    stubProbe(false);
    await expect(
      service.create({
        ...createData,
        enabled: false,
        provider_installation_id: appId,
      } as typeof createData)
    ).rejects.toThrow('unsupported write fields: provider_installation_id');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('enables an existing draft through the verified generation-fenced seam', async () => {
    const { service, updateWithVerifiedProviderInstallation } = makeService();
    stubProbe(true);
    await service.patch(draft.id, { enabled: true });
    expect(updateWithVerifiedProviderInstallation).toHaveBeenCalledWith(
      draft.id,
      { enabled: true },
      appId,
      draft.provider_config_generation
    );
  });

  it('probes a password-only rotation on an enabled channel without bumping authority', async () => {
    const enabled = { ...draft, enabled: true, provider_installation_id: appId };
    const { service, repository, updateWithVerifiedProviderInstallation } = makeService(enabled);
    const failing = stubProbe(false);
    await expect(
      service.patch(enabled.id, { config: { app_password: 'rotated' } })
    ).rejects.toThrow('Teams verification failed');
    expect(failing).toHaveBeenCalledOnce();
    expect(repository.update).not.toHaveBeenCalled();

    stubProbe(true);
    await service.patch(enabled.id, { config: { app_password: 'rotated' } });
    expect(updateWithVerifiedProviderInstallation).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith(enabled.id, {
      config: { app_password: 'rotated' },
    });
  });
});
