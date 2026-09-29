import {
  and,
  desc,
  eq,
  gatewayInboundEvents,
  inArray,
  select,
  sql,
  type TenantScopeAwareDatabase,
  teamsMessageDeliveries,
} from '@agor/core/db';
import type { GatewayChannelID } from '@agor/core/types';

const RECENT_SAMPLE_LIMIT = 100;
const TERMINAL_ID_LIMIT = 50;
const SAFE_OUTCOMES = new Set(['used', 'empty', 'fallback']);
const SAFE_REASONS = new Set([
  'disabled',
  'unavailable',
  'correlation_incomplete',
  'incomplete',
  'truncated',
  'invalid',
]);
const SAFE_ERROR_CODES = new Set([
  'payload_expired',
  'teams_channel_disabled_or_missing',
  'teams_config_generation_or_identity_changed',
  'teams_payload_identity_mismatch',
  'teams_gateway_service_unavailable',
  'teams_inbound_completion_fence_lost',
  'route_missing_or_disabled',
  'config_generation_changed',
  'conversation_address_stale',
  'conversation_address_missing',
  'conversation_address_invalid',
  'provider_rejected',
  'pre_effect_failure',
  'provider_effect_unknown',
]);

export interface TeamsGatewayDiagnostics {
  channel_id: GatewayChannelID;
  ingress: {
    counts: Record<string, number>;
    latest_received_at: string | null;
    last_safe_error: { code: string; at: string } | null;
    dead_letter_ids: string[];
  };
  catch_up: {
    counts: Record<string, number>;
    latest_at: string | null;
    last_state: { outcome: string; reason?: string; at: string } | null;
    sample_size: number;
  };
  outbound: {
    counts: Record<string, number>;
    latest_updated_at: string | null;
    last_safe_error: { code: string; at: string } | null;
    ambiguous_ids: string[];
    dead_letter_ids: string[];
  };
}

function safeErrorCode(value: unknown): string | null {
  return typeof value === 'string' && SAFE_ERROR_CODES.has(value) ? value : null;
}

function countRows(rows: Array<{ status: string; count: unknown }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count) || 0]));
}

function catchUpState(metadata: unknown): { outcome: string; reason?: string } | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const state = (metadata as Record<string, unknown>).teams_catch_up;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const outcome = (state as Record<string, unknown>).outcome;
  if (typeof outcome !== 'string' || !SAFE_OUTCOMES.has(outcome)) return null;
  const reason = (state as Record<string, unknown>).reason;
  return {
    outcome,
    ...(typeof reason === 'string' && SAFE_REASONS.has(reason) ? { reason } : {}),
  };
}

/** Read bounded, tenant-scoped Teams queue facts without payloads or secrets. */
export async function readTeamsGatewayDiagnostics(
  db: TenantScopeAwareDatabase,
  channelId: GatewayChannelID
): Promise<TeamsGatewayDiagnostics> {
  const ingressCounts = await select(db, {
    status: gatewayInboundEvents.status,
    count: sql<number>`count(*)`,
  })
    .from(gatewayInboundEvents)
    .where(eq(gatewayInboundEvents.gateway_channel_id, channelId))
    .groupBy(gatewayInboundEvents.status)
    .all();
  const recentIngress = await select(db, {
    receivedAt: gatewayInboundEvents.received_at,
    lastErrorCode: gatewayInboundEvents.last_error_code,
    deliveryMetadata: gatewayInboundEvents.delivery_metadata,
  })
    .from(gatewayInboundEvents)
    .where(eq(gatewayInboundEvents.gateway_channel_id, channelId))
    .orderBy(desc(gatewayInboundEvents.received_at), desc(gatewayInboundEvents.id))
    .limit(RECENT_SAMPLE_LIMIT)
    .all();
  const deadLetterIngress = await select(db, { eventId: gatewayInboundEvents.id })
    .from(gatewayInboundEvents)
    .where(
      and(
        eq(gatewayInboundEvents.gateway_channel_id, channelId),
        eq(gatewayInboundEvents.status, 'dead_letter')
      )
    )
    .orderBy(desc(gatewayInboundEvents.received_at), desc(gatewayInboundEvents.id))
    .limit(TERMINAL_ID_LIMIT)
    .all();

  const outboundCounts = await select(db, {
    status: teamsMessageDeliveries.status,
    count: sql<number>`count(*)`,
  })
    .from(teamsMessageDeliveries)
    .where(eq(teamsMessageDeliveries.gateway_channel_id, channelId))
    .groupBy(teamsMessageDeliveries.status)
    .all();
  const recentOutbound = await select(db, {
    deliveryId: teamsMessageDeliveries.delivery_id,
    updatedAt: teamsMessageDeliveries.updated_at,
    lastErrorCode: teamsMessageDeliveries.last_error_code,
  })
    .from(teamsMessageDeliveries)
    .where(eq(teamsMessageDeliveries.gateway_channel_id, channelId))
    .orderBy(desc(teamsMessageDeliveries.updated_at), desc(teamsMessageDeliveries.delivery_id))
    .limit(RECENT_SAMPLE_LIMIT)
    .all();
  const terminalIds = await select(db, {
    deliveryId: teamsMessageDeliveries.delivery_id,
    status: teamsMessageDeliveries.status,
  })
    .from(teamsMessageDeliveries)
    .where(
      and(
        eq(teamsMessageDeliveries.gateway_channel_id, channelId),
        inArray(teamsMessageDeliveries.status, ['ambiguous', 'dead_letter'])
      )
    )
    .orderBy(desc(teamsMessageDeliveries.updated_at), desc(teamsMessageDeliveries.delivery_id))
    .limit(TERMINAL_ID_LIMIT * 2)
    .all();

  const ingressRows = recentIngress as Array<{
    receivedAt: Date | string;
    lastErrorCode: unknown;
    deliveryMetadata: unknown;
  }>;
  const outboundRows = recentOutbound as Array<{
    deliveryId: string;
    updatedAt: Date | string;
    lastErrorCode: unknown;
  }>;
  const catchUpRows = ingressRows
    .map((row) => {
      const state = catchUpState(row.deliveryMetadata);
      return state ? { ...state, at: new Date(row.receivedAt).toISOString() } : null;
    })
    .filter((row): row is { outcome: string; reason?: string; at: string } => row !== null);
  const lastIngressError = ingressRows
    .map((row) => {
      const code = safeErrorCode(row.lastErrorCode);
      return code ? { code, at: new Date(row.receivedAt).toISOString() } : null;
    })
    .find((row): row is { code: string; at: string } => row !== null);
  const lastOutboundError = outboundRows
    .map((row) => {
      const code = safeErrorCode(row.lastErrorCode);
      return code ? { code, at: new Date(row.updatedAt).toISOString() } : null;
    })
    .find((row): row is { code: string; at: string } => row !== null);

  return {
    channel_id: channelId,
    ingress: {
      counts: countRows(ingressCounts as Array<{ status: string; count: unknown }>),
      latest_received_at: ingressRows[0] ? new Date(ingressRows[0].receivedAt).toISOString() : null,
      last_safe_error: lastIngressError ?? null,
      dead_letter_ids: (deadLetterIngress as Array<{ eventId: string }>).map((row) => row.eventId),
    },
    catch_up: {
      counts: Object.fromEntries(
        [...new Set(catchUpRows.map((row) => row.outcome))].map((outcome) => [
          outcome,
          catchUpRows.filter((row) => row.outcome === outcome).length,
        ])
      ),
      latest_at: catchUpRows[0]?.at ?? null,
      last_state: catchUpRows[0] ?? null,
      sample_size: ingressRows.length,
    },
    outbound: {
      counts: countRows(outboundCounts as Array<{ status: string; count: unknown }>),
      latest_updated_at: outboundRows[0] ? new Date(outboundRows[0].updatedAt).toISOString() : null,
      last_safe_error: lastOutboundError ?? null,
      ambiguous_ids: (terminalIds as Array<{ deliveryId: string; status: string }>)
        .filter((row) => row.status === 'ambiguous')
        .slice(0, TERMINAL_ID_LIMIT)
        .map((row) => row.deliveryId),
      dead_letter_ids: (terminalIds as Array<{ deliveryId: string; status: string }>)
        .filter((row) => row.status === 'dead_letter')
        .slice(0, TERMINAL_ID_LIMIT)
        .map((row) => row.deliveryId),
    },
  };
}
