import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayChannel, GatewayProviderAction } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CHANNEL_ID = '019fd900-0000-7000-8000-000000000101';
const ACTION_ID = '019fd900-0000-7000-8000-000000000102';
const OPERATOR_ID = '019fd900-0000-7000-8000-000000000103';
const APPLICATION_ID = '223456789012345678';
const MESSAGE_IDS = ['523456789012345678', '523456789012345679'];

const findChannel = vi.fn();
const findAction = vi.fn();
const repair = vi.fn();
const abandon = vi.fn();
const isPostgres = vi.fn(() => true);

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    isPostgresDatabase: isPostgres,
    runWithTenantDatabaseScope: vi.fn(async (_db, _tenantId, work) => work({})),
    GatewayChannelRepository: class {
      findById = findChannel;
    },
    GatewayProviderActionRepository: class {
      findById = findAction;
      repairDiscordDeliveryCoordinates = repair;
      abandonDiscordDelivery = abandon;
    },
  };
});

const {
  createGatewayDiscordProviderOperationsService,
  DISCORD_DELIVERY_ABANDON_CONFIRMATION,
  DISCORD_DELIVERY_COORDINATE_CONFIRMATION,
} = await import('./gateway-discord-provider-operations.js');
const { runWithTenantContext } = await import('@agor/core/db');

const channel = {
  id: CHANNEL_ID,
  channel_type: 'discord',
  enabled: true,
  provider_installation_id: APPLICATION_ID,
  provider_config_generation: 4,
  agor_user_id: OPERATOR_ID,
  config: {
    application_id: APPLICATION_ID,
    guild_id: '323456789012345678',
    allowed_channel_ids: ['423456789012345678'],
    bot_token: 'must-never-return',
    align_discord_users: false,
  },
} as unknown as GatewayChannel;

const execution = {
  kind: 'discord_delivery' as const,
  formatter_version: 1,
  source_sha256: 'a'.repeat(64),
  chunks: [
    { index: 0, descriptor_sha256: 'b'.repeat(64), provider_message_id: MESSAGE_IDS[0] },
    { index: 1, descriptor_sha256: 'c'.repeat(64) },
  ],
  overflow_attachment: {
    chunk_index: 1,
    filename: 'agor-response.md' as const,
    content_sha256: 'd'.repeat(64),
    byte_length: 100,
  },
};

const deadLetter = {
  id: ACTION_ID,
  gateway_channel_id: CHANNEL_ID,
  channel_type: 'discord',
  provider_installation_id: APPLICATION_ID,
  provider_config_generation: 4,
  kind: 'deliver_message',
  status: 'dead_letter',
  attempts: 3,
  last_error_code: 'discord_nonce_recovery_incomplete',
  execution_metadata: execution,
  created_at: '2026-08-18T00:00:00.000Z',
  updated_at: '2026-08-18T00:01:00.000Z',
  dead_lettered_at: '2026-08-18T00:01:00.000Z',
  completed_at: null,
  canceled_at: null,
} as unknown as GatewayProviderAction;

const params = {
  provider: 'rest',
  user: { user_id: OPERATOR_ID, role: ROLES.ADMIN },
} as never;

function appHarness() {
  const getProviderActionDiagnostic = vi.fn(async () => ({
    activeCount: 2,
    oldestDueAt: '2026-08-18T00:00:00.000Z',
    oldestDueAgeMs: 30_000,
    deadLetterCount: 1,
    partialDeliveryCount: 1,
    nonceRecoveryIncompleteCount: 1,
    historyIncompleteCount: 0,
    formatterMismatchCount: 0,
    observedAt: '2026-08-18T00:00:30.000Z',
    processorUpdatedAt: null,
  }));
  return {
    app: { service: vi.fn(() => ({ getProviderActionDiagnostic })) },
    getProviderActionDiagnostic,
  };
}

function createService() {
  const harness = appHarness();
  return {
    ...harness,
    service: createGatewayDiscordProviderOperationsService({} as never, harness.app as never),
  };
}

async function invoke(service: ReturnType<typeof createService>['service'], data: unknown) {
  return runWithTenantContext('tenant-a', () => service.create(data, params));
}

beforeEach(() => {
  findChannel.mockReset().mockResolvedValue(channel);
  findAction.mockReset().mockResolvedValue(deadLetter);
  repair.mockReset().mockResolvedValue(true);
  abandon.mockReset().mockResolvedValue(true);
  isPostgres.mockReset().mockReturnValue(true);
});

describe('Discord provider operations wiring', () => {
  const source = readFileSync(join(__dirname, '..', 'register-services.ts'), 'utf8');
  const start = source.indexOf(
    "app.service('gateway-channels/discord-provider-operations').hooks("
  );
  const block = start === -1 ? '' : source.slice(start, start + 430);

  it('is create-only, requireAuth/admin gated, and never published', () => {
    expect(source).toMatch(
      /gateway-channels\/discord-provider-operations'[\s\S]*?methods: \['create'\]/
    );
    expect(block).toMatch(/create:\s*\[[\s\S]*?ctx\.requireAuth,[\s\S]*?ROLES\.ADMIN/);
    expect(source).toMatch(
      /app\.service\('gateway-channels\/discord-provider-operations'\)\.publish\(\(\) => \[\]\)/
    );
  });
});

describe('Discord provider operations service', () => {
  it('returns bounded content-free channel diagnostics', async () => {
    const { service, getProviderActionDiagnostic } = createService();
    const result = await invoke(service, {
      operation: 'diagnostics',
      gatewayChannelId: CHANNEL_ID,
    });
    expect(result).toMatchObject({
      operation: 'diagnostics',
      gatewayChannelId: CHANNEL_ID,
      diagnostics: { activeCount: 2, partialDeliveryCount: 1 },
    });
    expect(getProviderActionDiagnostic).toHaveBeenCalledWith(CHANNEL_ID);
    expect(JSON.stringify(result)).not.toContain('must-never-return');
  });

  it('inspects only frozen content-free delivery coordinates and hashes', async () => {
    const { service } = createService();
    const result = await invoke(service, {
      operation: 'inspect_delivery',
      gatewayChannelId: CHANNEL_ID,
      actionId: ACTION_ID,
    });
    expect(result).toMatchObject({
      delivery: {
        actionId: ACTION_ID,
        status: 'dead_letter',
        repairAllowed: true,
        chunks: [
          { index: 0, providerMessageId: MESSAGE_IDS[0] },
          { index: 1, providerMessageId: null },
        ],
        overflowAttachment: { filename: 'agor-response.md', byteLength: 100 },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('must-never-return');
    expect(serialized).not.toContain('canonical assistant');
  });

  it('records exact server-frozen coordinates with only the authenticated operator', async () => {
    const { service } = createService();
    const repairedAction = {
      ...deadLetter,
      status: 'completed',
      last_error_code: null,
      completed_at: '2026-08-18T00:02:00.000Z',
      execution_metadata: {
        ...execution,
        chunks: execution.chunks.map((chunk, index) => ({
          ...chunk,
          provider_message_id: MESSAGE_IDS[index],
        })),
        repair: {
          outcome: 'coordinates_recorded',
          operator_user_id: OPERATOR_ID,
          repaired_at: '2026-08-18T00:02:00.000Z',
        },
      },
    } as GatewayProviderAction;
    findAction.mockResolvedValueOnce(deadLetter).mockResolvedValueOnce(repairedAction);
    const result = await invoke(service, {
      operation: 'record_delivery_coordinates',
      gatewayChannelId: CHANNEL_ID,
      actionId: ACTION_ID,
      providerMessageIds: MESSAGE_IDS,
      confirmation: DISCORD_DELIVERY_COORDINATE_CONFIRMATION,
    });
    expect(result).toMatchObject({ outcome: 'coordinates_recorded' });
    expect(repair).toHaveBeenCalledWith({
      actionId: ACTION_ID,
      channelId: CHANNEL_ID,
      operatorUserId: OPERATOR_ID,
      expectedMetadata: execution,
      providerMessageIds: MESSAGE_IDS,
    });
    expect(JSON.stringify(repair.mock.calls)).not.toContain('bot_token');
  });

  it('abandons without provider work and returns explicit manual-cleanup guidance', async () => {
    const { service } = createService();
    const abandonedAction = {
      ...deadLetter,
      status: 'canceled',
      last_error_code: 'operator_abandoned_delivery',
      canceled_at: '2026-08-18T00:02:00.000Z',
      execution_metadata: {
        ...execution,
        repair: {
          outcome: 'abandoned',
          operator_user_id: OPERATOR_ID,
          repaired_at: '2026-08-18T00:02:00.000Z',
        },
      },
    } as GatewayProviderAction;
    findAction.mockResolvedValueOnce(deadLetter).mockResolvedValueOnce(abandonedAction);
    const result = await invoke(service, {
      operation: 'abandon_delivery',
      gatewayChannelId: CHANNEL_ID,
      actionId: ACTION_ID,
      confirmation: DISCORD_DELIVERY_ABANDON_CONFIRMATION,
    });
    expect(result).toMatchObject({
      outcome: 'abandoned',
      warning: expect.stringMatching(/removed manually/),
    });
    expect(abandon).toHaveBeenCalledWith({
      actionId: ACTION_ID,
      channelId: CHANNEL_ID,
      operatorUserId: OPERATOR_ID,
      expectedMetadata: execution,
    });
  });

  it('strictly rejects extra fields, confirmations, coordinate conflicts, and SQLite', async () => {
    const { service } = createService();
    await expect(
      invoke(service, {
        operation: 'diagnostics',
        gatewayChannelId: CHANNEL_ID,
        operator_user_id: OPERATOR_ID,
      })
    ).rejects.toMatchObject({ name: 'BadRequest' });
    await expect(
      invoke(service, {
        operation: 'record_delivery_coordinates',
        gatewayChannelId: CHANNEL_ID,
        actionId: ACTION_ID,
        providerMessageIds: [MESSAGE_IDS[0], MESSAGE_IDS[0]],
        confirmation: 'yes',
      })
    ).rejects.toMatchObject({ name: 'BadRequest' });
    isPostgres.mockReturnValue(false);
    await expect(
      invoke(service, { operation: 'diagnostics', gatewayChannelId: CHANNEL_ID })
    ).rejects.toThrow(/require PostgreSQL/);
  });

  it('defends authentication, admin role, current binding, status, and frozen metadata', async () => {
    const { service } = createService();
    await expect(
      runWithTenantContext('tenant-a', () =>
        service.create({ operation: 'diagnostics', gatewayChannelId: CHANNEL_ID })
      )
    ).rejects.toMatchObject({ name: 'NotAuthenticated' });
    await expect(
      runWithTenantContext('tenant-a', () =>
        service.create({ operation: 'diagnostics', gatewayChannelId: CHANNEL_ID }, {
          user: { user_id: OPERATOR_ID, role: ROLES.MEMBER },
        } as never)
      )
    ).rejects.toMatchObject({ name: 'Forbidden' });

    findAction.mockResolvedValueOnce({ ...deadLetter, provider_config_generation: 3 });
    await expect(
      invoke(service, {
        operation: 'inspect_delivery',
        gatewayChannelId: CHANNEL_ID,
        actionId: ACTION_ID,
      })
    ).rejects.toMatchObject({ name: 'NotFound' });

    findAction.mockResolvedValueOnce({ ...deadLetter, status: 'pending' });
    await expect(
      invoke(service, {
        operation: 'inspect_delivery',
        gatewayChannelId: CHANNEL_ID,
        actionId: ACTION_ID,
      })
    ).rejects.toMatchObject({ name: 'Conflict' });

    findAction.mockResolvedValueOnce({ ...deadLetter, execution_metadata: null });
    await expect(
      invoke(service, {
        operation: 'inspect_delivery',
        gatewayChannelId: CHANNEL_ID,
        actionId: ACTION_ID,
      })
    ).rejects.toThrow(/frozen execution metadata/);
  });

  it('fails generically on cross-tenant/wrong binding and deterministically fences a race', async () => {
    const { service } = createService();
    findAction.mockResolvedValueOnce(null);
    await expect(
      invoke(service, {
        operation: 'inspect_delivery',
        gatewayChannelId: CHANNEL_ID,
        actionId: ACTION_ID,
      })
    ).rejects.toMatchObject({ name: 'NotFound', message: expect.stringMatching(/not found/i) });

    findAction.mockResolvedValue(deadLetter);
    repair.mockResolvedValue(false);
    await expect(
      invoke(service, {
        operation: 'record_delivery_coordinates',
        gatewayChannelId: CHANNEL_ID,
        actionId: ACTION_ID,
        providerMessageIds: MESSAGE_IDS,
        confirmation: DISCORD_DELIVERY_COORDINATE_CONFIRMATION,
      })
    ).rejects.toMatchObject({ name: 'Conflict', message: expect.stringMatching(/changed/i) });
  });

  it('returns an idempotent-safe outcome for a later exact repeat', async () => {
    const { service } = createService();
    findAction.mockResolvedValue({
      ...deadLetter,
      status: 'completed',
      last_error_code: null,
      completed_at: '2026-08-18T00:02:00.000Z',
      execution_metadata: {
        ...execution,
        chunks: execution.chunks.map((chunk, index) => ({
          ...chunk,
          provider_message_id: MESSAGE_IDS[index],
        })),
        repair: {
          outcome: 'coordinates_recorded',
          operator_user_id: OPERATOR_ID,
          repaired_at: '2026-08-18T00:02:00.000Z',
        },
      },
    });
    await expect(
      invoke(service, {
        operation: 'record_delivery_coordinates',
        gatewayChannelId: CHANNEL_ID,
        actionId: ACTION_ID,
        providerMessageIds: MESSAGE_IDS,
        confirmation: DISCORD_DELIVERY_COORDINATE_CONFIRMATION,
      })
    ).resolves.toMatchObject({ outcome: 'already_repaired' });
    expect(repair).not.toHaveBeenCalled();
  });
});
