/** Admin-only, content-free Discord provider delivery operations. */

import {
  GatewayChannelRepository,
  GatewayProviderActionRepository,
  isPostgresDatabase,
  RepositoryError,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import {
  type Application,
  BadRequest,
  Conflict,
  Forbidden,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import {
  DISCORD_MESSAGE_MAX_CHUNKS,
  isDiscordSnowflake,
  parseDiscordGatewayConfig,
} from '@agor/core/gateway';
import type {
  AuthenticatedParams,
  GatewayChannel,
  GatewayChannelID,
  GatewayDiscordDeliveryExecutionMetadata,
  GatewayProviderAction,
  GatewayProviderActionID,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, isCanonicalFullUuid, ROLES } from '@agor/core/types';

export const DISCORD_DELIVERY_COORDINATE_CONFIRMATION =
  'RECORD_VERIFIED_DISCORD_MESSAGE_COORDINATES_WITHOUT_POSTING';
export const DISCORD_DELIVERY_ABANDON_CONFIRMATION =
  'ABANDON_DISCORD_DELIVERY_AND_CLEAN_UP_PARTIAL_MESSAGES_MANUALLY';

type DiagnosticsOperation = {
  operation: 'diagnostics';
  gatewayChannelId: string;
};

type InspectDeliveryOperation = {
  operation: 'inspect_delivery';
  gatewayChannelId: string;
  actionId: string;
};

type RecordCoordinatesOperation = {
  operation: 'record_delivery_coordinates';
  gatewayChannelId: string;
  actionId: string;
  providerMessageIds: string[];
  confirmation: string;
};

type AbandonDeliveryOperation = {
  operation: 'abandon_delivery';
  gatewayChannelId: string;
  actionId: string;
  confirmation: string;
};

export type GatewayDiscordProviderOperationInput =
  | DiagnosticsOperation
  | InspectDeliveryOperation
  | RecordCoordinatesOperation
  | AbandonDeliveryOperation;

const OPERATION_KEYS = {
  diagnostics: ['operation', 'gatewayChannelId'],
  inspect_delivery: ['operation', 'gatewayChannelId', 'actionId'],
  record_delivery_coordinates: [
    'operation',
    'gatewayChannelId',
    'actionId',
    'providerMessageIds',
    'confirmation',
  ],
  abandon_delivery: ['operation', 'gatewayChannelId', 'actionId', 'confirmation'],
} as const;

function hasExactKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(raw).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function assertCanonicalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !isCanonicalFullUuid(value)) {
    throw new BadRequest(`${label} must be a canonical UUID`);
  }
}

function parseInput(value: unknown): GatewayDiscordProviderOperationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequest('Discord provider operation must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.operation !== 'diagnostics' &&
    raw.operation !== 'inspect_delivery' &&
    raw.operation !== 'record_delivery_coordinates' &&
    raw.operation !== 'abandon_delivery'
  ) {
    throw new BadRequest('Discord provider operation is not supported');
  }
  if (!hasExactKeys(raw, OPERATION_KEYS[raw.operation])) {
    throw new BadRequest('Discord provider operation contains unsupported fields');
  }
  assertCanonicalId(raw.gatewayChannelId, 'gatewayChannelId');
  if (raw.operation === 'diagnostics') return raw as DiagnosticsOperation;
  assertCanonicalId(raw.actionId, 'actionId');
  if (raw.operation === 'inspect_delivery') return raw as InspectDeliveryOperation;
  if (raw.operation === 'abandon_delivery') {
    if (raw.confirmation !== DISCORD_DELIVERY_ABANDON_CONFIRMATION) {
      throw new BadRequest('Discord delivery abandonment confirmation is invalid');
    }
    return raw as AbandonDeliveryOperation;
  }
  if (
    raw.confirmation !== DISCORD_DELIVERY_COORDINATE_CONFIRMATION ||
    !Array.isArray(raw.providerMessageIds) ||
    raw.providerMessageIds.length < 1 ||
    raw.providerMessageIds.length > DISCORD_MESSAGE_MAX_CHUNKS ||
    raw.providerMessageIds.some((id) => !isDiscordSnowflake(id)) ||
    new Set(raw.providerMessageIds).size !== raw.providerMessageIds.length
  ) {
    throw new BadRequest('Discord delivery coordinates or confirmation are invalid');
  }
  return raw as RecordCoordinatesOperation;
}

function requireOperator(params?: AuthenticatedParams): UserID {
  const operator = params?.user;
  if (!operator) throw new NotAuthenticated('Authentication required');
  if (!hasMinimumRole(operator.role, ROLES.ADMIN)) {
    throw new Forbidden('Admin access is required for Discord provider operations');
  }
  if (!isCanonicalFullUuid(operator.user_id)) {
    throw new NotAuthenticated('Authenticated operator identity is invalid');
  }
  return operator.user_id as UserID;
}

function deliveryMetadata(action: GatewayProviderAction): GatewayDiscordDeliveryExecutionMetadata {
  const metadata = action.execution_metadata;
  if (metadata?.kind !== 'discord_delivery' || metadata.chunks.length < 1) {
    throw new Conflict('Discord delivery has no frozen execution metadata');
  }
  return metadata;
}

function assertActionBinding(
  channel: GatewayChannel,
  action: GatewayProviderAction | null
): asserts action is GatewayProviderAction {
  if (
    !action ||
    action.gateway_channel_id !== channel.id ||
    action.channel_type !== 'discord' ||
    action.kind !== 'deliver_message' ||
    action.provider_installation_id !== channel.provider_installation_id ||
    action.provider_config_generation !== channel.provider_config_generation
  ) {
    throw new NotFound('Discord delivery operation target was not found');
  }
}

function inspectDelivery(action: GatewayProviderAction) {
  const metadata = deliveryMetadata(action);
  const audit = metadata.repair;
  const operationalStatus =
    action.status === 'dead_letter' ||
    (action.status === 'completed' && audit?.outcome === 'coordinates_recorded') ||
    (action.status === 'canceled' && audit?.outcome === 'abandoned');
  if (!operationalStatus) {
    throw new Conflict('Discord delivery is not in an inspectable repair state');
  }
  return {
    gatewayChannelId: action.gateway_channel_id,
    actionId: action.id,
    kind: action.kind,
    status: action.status,
    lastErrorCode: action.last_error_code,
    attempts: action.attempts,
    createdAt: action.created_at,
    updatedAt: action.updated_at,
    deadLetteredAt: action.dead_lettered_at,
    completedAt: action.completed_at,
    canceledAt: action.canceled_at,
    formatterVersion: metadata.formatter_version,
    sourceSha256: metadata.source_sha256,
    chunks: metadata.chunks.map((chunk) => ({
      index: chunk.index,
      descriptorSha256: chunk.descriptor_sha256,
      providerMessageId: chunk.provider_message_id ?? null,
    })),
    overflowAttachment: metadata.overflow_attachment
      ? {
          chunkIndex: metadata.overflow_attachment.chunk_index,
          filename: metadata.overflow_attachment.filename,
          contentSha256: metadata.overflow_attachment.content_sha256,
          byteLength: metadata.overflow_attachment.byte_length,
        }
      : null,
    repair: audit
      ? {
          outcome: audit.outcome,
          repairedAt: audit.repaired_at,
          operatorUserId: audit.operator_user_id,
          operatorShortId: shortId(audit.operator_user_id),
        }
      : null,
    repairAllowed: action.status === 'dead_letter' && !audit,
    abandonAllowed: action.status === 'dead_letter' && !audit,
    manualCleanupRequired: audit?.outcome === 'abandoned',
  };
}

async function requirePostgres(db: TenantScopeAwareDatabase): Promise<void> {
  const tenantId = requireCurrentTenantId(
    'Discord provider operations require trusted tenant context'
  );
  const postgres = await runWithTenantDatabaseScope(db, tenantId, async (scopedDb) =>
    isPostgresDatabase(scopedDb)
  );
  if (!postgres) {
    throw new BadRequest('Discord provider operations require PostgreSQL');
  }
}

export function createGatewayDiscordProviderOperationsService(
  db: TenantScopeAwareDatabase,
  app: Application
) {
  const channels = new GatewayChannelRepository(db);
  const actions = new GatewayProviderActionRepository(db);

  async function loadChannel(channelId: string): Promise<GatewayChannel> {
    const channel = await channels.findById(channelId);
    if (!channel) throw new NotFound('Discord provider operation target was not found');
    if (
      channel.channel_type !== 'discord' ||
      !channel.enabled ||
      !channel.provider_installation_id ||
      channel.provider_config_generation < 1
    ) {
      throw new Conflict('Discord gateway channel is not currently provider-authorized');
    }
    try {
      const config = parseDiscordGatewayConfig(channel.config, {
        enabled: true,
        agorUserId: channel.agor_user_id,
      });
      if (config.application_id !== channel.provider_installation_id) throw new Error('mismatch');
    } catch {
      throw new Conflict('Discord gateway channel is not currently provider-authorized');
    }
    return channel;
  }

  return {
    async create(data: unknown, params?: AuthenticatedParams) {
      const input = parseInput(data);
      const operatorUserId = requireOperator(params);
      await requirePostgres(db);
      const channel = await loadChannel(input.gatewayChannelId);

      if (input.operation === 'diagnostics') {
        const gateway = app.service('gateway') as unknown as {
          getProviderActionDiagnostic: (channelId: GatewayChannelID) => Promise<unknown>;
        };
        return {
          operation: input.operation,
          gatewayChannelId: channel.id,
          diagnostics: await gateway.getProviderActionDiagnostic(channel.id),
        };
      }

      const action = await actions.findById(input.actionId as GatewayProviderActionID);
      assertActionBinding(channel, action);
      const before = inspectDelivery(action);
      const expectedMetadata = deliveryMetadata(action);

      if (input.operation === 'inspect_delivery') {
        return { operation: input.operation, delivery: before };
      }

      if (input.operation === 'record_delivery_coordinates') {
        if (
          action.status === 'completed' &&
          expectedMetadata.repair?.outcome === 'coordinates_recorded'
        ) {
          const existing = expectedMetadata.chunks.map((chunk) => chunk.provider_message_id);
          if (
            existing.length === input.providerMessageIds.length &&
            existing.every((id, index) => id === input.providerMessageIds[index])
          ) {
            return { operation: input.operation, outcome: 'already_repaired', delivery: before };
          }
          throw new Conflict('Discord delivery was already repaired differently');
        }
        if (action.status !== 'dead_letter' || expectedMetadata.repair) {
          throw new Conflict('Discord delivery cannot be repaired in its current state');
        }
        if (input.providerMessageIds.length !== expectedMetadata.chunks.length) {
          throw new BadRequest('One ordered Discord coordinate is required for every chunk');
        }
        try {
          const repaired = await actions.repairDiscordDeliveryCoordinates({
            actionId: action.id,
            channelId: channel.id,
            operatorUserId,
            expectedMetadata,
            providerMessageIds: input.providerMessageIds,
          });
          if (!repaired) {
            throw new Conflict('Discord delivery changed during repair; inspect it again');
          }
        } catch (error) {
          if (error instanceof Conflict || error instanceof BadRequest) throw error;
          if (error instanceof RepositoryError) {
            throw new Conflict('Discord delivery could not be repaired safely');
          }
          throw error;
        }
        const repaired = await actions.findById(action.id);
        assertActionBinding(channel, repaired);
        return {
          operation: input.operation,
          outcome: 'coordinates_recorded',
          delivery: inspectDelivery(repaired),
        };
      }

      if (action.status === 'canceled' && expectedMetadata.repair?.outcome === 'abandoned') {
        return { operation: input.operation, outcome: 'already_abandoned', delivery: before };
      }
      if (action.status !== 'dead_letter' || expectedMetadata.repair) {
        throw new Conflict('Discord delivery cannot be abandoned in its current state');
      }
      try {
        const abandoned = await actions.abandonDiscordDelivery({
          actionId: action.id,
          channelId: channel.id,
          operatorUserId,
          expectedMetadata,
        });
        if (!abandoned) {
          throw new Conflict('Discord delivery changed during abandonment; inspect it again');
        }
      } catch (error) {
        if (error instanceof Conflict) throw error;
        if (error instanceof RepositoryError) {
          throw new Conflict('Discord delivery could not be abandoned safely');
        }
        throw error;
      }
      const abandoned = await actions.findById(action.id);
      assertActionBinding(channel, abandoned);
      return {
        operation: input.operation,
        outcome: 'abandoned',
        warning: 'Partial Discord messages, if any, must be removed manually.',
        delivery: inspectDelivery(abandoned),
      };
    },
  };
}
