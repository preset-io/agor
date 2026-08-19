/** Bounded canonical shapes shared by provider-action persistence transitions. */

import type { DistributedWorkIdentity } from '../../coordination';
import { compareDiscordSnowflakes } from '../../gateway/connectors/discord-config';
import {
  DISCORD_DELIVERY_EXECUTION_METADATA_MAX_BYTES,
  DISCORD_DELIVERY_MAX_OVERFLOW_BYTES,
  DISCORD_DELIVERY_OVERFLOW_FILENAME,
  DISCORD_DELIVERY_SHA256_PATTERN,
} from '../../gateway/connectors/discord-delivery';
import {
  DISCORD_THREAD_HISTORY_MAX_LIMIT,
  DISCORD_THREAD_HISTORY_SNAPSHOT_MAX_BYTES,
} from '../../gateway/connectors/discord-thread-history';
import type {
  GatewayChannelID,
  GatewayDeliverMessageActionParams,
  GatewayDiscordDeliveryExecutionMetadata,
  GatewayDiscordNoticeActionParams,
  GatewayDiscordProgressActionParams,
  GatewayDiscordThreadHistoryActionParams,
  GatewayInboundEventID,
  GatewayProviderAction,
  GatewayProviderActionID,
  GatewayProviderActionKind,
  GatewayProviderActionParams,
  GatewayProviderActionResultMetadata,
  MessageID,
  SessionID,
  TaskID,
  ThreadSessionMapID,
} from '../../types';
import { isCanonicalFullUuid } from '../../types';
import type { GatewayProviderActionRow } from '../schema';
import { RepositoryError } from './base';

export const GATEWAY_PROVIDER_ACTION_IDEMPOTENCY_KEY_MAX_BYTES = 200;
export const GATEWAY_PROVIDER_ACTION_PARAMS_MAX_BYTES = 512;
export const GATEWAY_PROVIDER_ACTION_RESULT_MAX_BYTES = 512;
export const GATEWAY_PROVIDER_ACTION_MAX_BACKLOG = 10_000;
export const GATEWAY_PROVIDER_ACTION_MAX_CLAIM_BATCH = 25;
export const GATEWAY_PROVIDER_ACTION_MAX_LEASE_MS = 5 * 60_000;
export const GATEWAY_PROVIDER_ACTION_MAX_RETRY_MS = 7 * 24 * 60 * 60_000;
export const GATEWAY_PROVIDER_ACTION_MAX_ACTIVITY_TTL_MS = 15 * 60_000;
/** Routing failures become misleading quickly after access/config is repaired. */
export const GATEWAY_PROVIDER_ACTION_DISCORD_NOTICE_TTL_MS = 2 * 60_000;
export const GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES = ['pending', 'processing', 'retry'] as const;
const MAX_PROVIDER_COORDINATE_BYTES = 128;
const MAX_CLAIM_TOKEN_BYTES = 200;
const PROVIDER_COORDINATE_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type GatewayProviderActionEnqueueResult =
  | { outcome: 'enqueued'; action: GatewayProviderAction }
  | { outcome: 'duplicate'; action: GatewayProviderAction };

interface GatewayProviderActionMappedEnqueueBase {
  channelId: GatewayChannelID;
  idempotencyKey: string;
  mappingId: ThreadSessionMapID;
  sessionId: SessionID;
}

export interface GatewayDeliverMessageActionEnqueueInput
  extends GatewayProviderActionMappedEnqueueBase {
  kind: 'deliver_message';
  taskId: TaskID;
  messageId: MessageID;
  inboundEventId?: GatewayInboundEventID;
  params: GatewayDeliverMessageActionParams;
}

export interface GatewayDiscordProgressActionEnqueueInput
  extends GatewayProviderActionMappedEnqueueBase {
  kind: 'discord_progress';
  taskId: TaskID;
  messageId?: never;
  inboundEventId?: GatewayInboundEventID;
  params: GatewayDiscordProgressActionParams;
  /** Relative to database time, so daemon clock skew cannot extend correctness leases. */
  dropAfterMs?: number;
}

export interface GatewayDiscordThreadHistoryActionEnqueueInput
  extends GatewayProviderActionMappedEnqueueBase {
  kind: 'discord_thread_history';
  taskId?: never;
  messageId?: never;
  inboundEventId?: never;
  params: GatewayDiscordThreadHistoryActionParams;
  dropAfterMs?: never;
}

export interface GatewayDiscordNoticeActionEnqueueInput {
  kind: 'discord_notice';
  channelId: GatewayChannelID;
  idempotencyKey: string;
  inboundEventId: GatewayInboundEventID;
  mappingId?: never;
  sessionId?: never;
  taskId?: never;
  messageId?: never;
  params: GatewayDiscordNoticeActionParams;
  /** Fixed by the repository relative to database time; callers cannot extend it. */
  dropAfterMs?: never;
}

export type GatewayProviderActionEnqueueInput =
  | GatewayDeliverMessageActionEnqueueInput
  | GatewayDiscordProgressActionEnqueueInput
  | GatewayDiscordNoticeActionEnqueueInput
  | GatewayDiscordThreadHistoryActionEnqueueInput;

export interface GatewayProviderActionClaimInput {
  channelId: GatewayChannelID;
  listenerClaimToken: string;
  listenerGeneration: number;
  actionClaimToken: string;
  leaseMs: number;
  limit: number;
  identity: DistributedWorkIdentity;
}

export function providerActionRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertProviderActionBoundedNonEmpty(
  value: string,
  maxBytes: number,
  label: string
): void {
  if (!value.trim() || utf8Bytes(value) > maxBytes) {
    throw new RepositoryError(`${label} must be non-empty and at most ${maxBytes} bytes`);
  }
}

export function assertProviderActionCanonicalId(value: string | undefined, label: string): void {
  if (value !== undefined && !isCanonicalFullUuid(value)) {
    throw new RepositoryError(`${label} must be a canonical UUID`);
  }
}

export function assertProviderActionPositiveInteger(
  value: number,
  maximum: number,
  label: string
): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RepositoryError(`${label} must be between 1 and ${maximum}`);
  }
}

function isDiscordSnowflake(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) return false;
  try {
    return BigInt(value) <= (1n << 64n) - 1n;
  } catch {
    return false;
  }
}

function hasExactKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((key) => allowed.includes(key));
}

/** Strict parser for content-free, independently durable Discord chunks. */
export function parseGatewayProviderActionExecutionMetadata(
  value: unknown,
  kind: GatewayProviderActionKind
): GatewayDiscordDeliveryExecutionMetadata | null {
  if (value === null || value === undefined) return null;
  if (
    (kind !== 'deliver_message' && kind !== 'discord_notice') ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new RepositoryError('Invalid gateway provider action execution metadata');
  }
  const raw = value as Record<string, unknown>;
  if (
    !hasExactKeys(raw, [
      'kind',
      'formatter_version',
      'source_sha256',
      'chunks',
      'overflow_attachment',
      'repair',
    ]) ||
    raw.kind !== 'discord_delivery' ||
    !Number.isSafeInteger(raw.formatter_version) ||
    Number(raw.formatter_version) < 1 ||
    Number(raw.formatter_version) > 2_147_483_647 ||
    typeof raw.source_sha256 !== 'string' ||
    !DISCORD_DELIVERY_SHA256_PATTERN.test(raw.source_sha256) ||
    !Array.isArray(raw.chunks) ||
    raw.chunks.length < 1 ||
    raw.chunks.length > 8
  ) {
    throw new RepositoryError('Invalid gateway provider action execution metadata');
  }

  const providerIds = new Set<string>();
  const chunks = raw.chunks.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RepositoryError('Invalid Discord delivery chunk checkpoint');
    }
    const chunk = value as Record<string, unknown>;
    if (
      !hasExactKeys(chunk, ['index', 'descriptor_sha256', 'provider_message_id']) ||
      chunk.index !== index ||
      typeof chunk.descriptor_sha256 !== 'string' ||
      !DISCORD_DELIVERY_SHA256_PATTERN.test(chunk.descriptor_sha256) ||
      (chunk.provider_message_id !== undefined && !isDiscordSnowflake(chunk.provider_message_id))
    ) {
      throw new RepositoryError('Invalid Discord delivery chunk checkpoint');
    }
    if (typeof chunk.provider_message_id === 'string') {
      if (providerIds.has(chunk.provider_message_id)) {
        throw new RepositoryError('Discord delivery provider coordinates must be unique');
      }
      providerIds.add(chunk.provider_message_id);
    }
    return chunk;
  });

  let overflowAttachment: Record<string, unknown> | undefined;
  if (raw.overflow_attachment !== undefined) {
    if (
      !raw.overflow_attachment ||
      typeof raw.overflow_attachment !== 'object' ||
      Array.isArray(raw.overflow_attachment)
    ) {
      throw new RepositoryError('Invalid Discord delivery overflow checkpoint');
    }
    const overflow = raw.overflow_attachment as Record<string, unknown>;
    if (
      !hasExactKeys(overflow, ['chunk_index', 'filename', 'content_sha256', 'byte_length']) ||
      overflow.chunk_index !== chunks.length - 1 ||
      overflow.filename !== DISCORD_DELIVERY_OVERFLOW_FILENAME ||
      typeof overflow.content_sha256 !== 'string' ||
      !DISCORD_DELIVERY_SHA256_PATTERN.test(overflow.content_sha256) ||
      !Number.isSafeInteger(overflow.byte_length) ||
      Number(overflow.byte_length) < 1 ||
      Number(overflow.byte_length) > DISCORD_DELIVERY_MAX_OVERFLOW_BYTES
    ) {
      throw new RepositoryError('Invalid Discord delivery overflow checkpoint');
    }
    overflowAttachment = overflow;
  }

  let repair: Record<string, unknown> | undefined;
  if (raw.repair !== undefined) {
    if (!raw.repair || typeof raw.repair !== 'object' || Array.isArray(raw.repair)) {
      throw new RepositoryError('Invalid Discord delivery repair audit');
    }
    const candidate = raw.repair as Record<string, unknown>;
    if (
      !hasExactKeys(candidate, ['outcome', 'operator_user_id', 'repaired_at']) ||
      (candidate.outcome !== 'coordinates_recorded' && candidate.outcome !== 'abandoned') ||
      typeof candidate.operator_user_id !== 'string' ||
      !isCanonicalFullUuid(candidate.operator_user_id) ||
      typeof candidate.repaired_at !== 'string' ||
      !Number.isFinite(Date.parse(candidate.repaired_at)) ||
      new Date(candidate.repaired_at).toISOString() !== candidate.repaired_at
    ) {
      throw new RepositoryError('Invalid Discord delivery repair audit');
    }
    repair = candidate;
  }

  if (utf8Bytes(JSON.stringify(raw)) > DISCORD_DELIVERY_EXECUTION_METADATA_MAX_BYTES) {
    throw new RepositoryError('Gateway provider action execution metadata is too large');
  }
  return {
    kind: 'discord_delivery',
    formatter_version: Number(raw.formatter_version),
    source_sha256: raw.source_sha256,
    chunks: chunks as unknown as GatewayDiscordDeliveryExecutionMetadata['chunks'],
    ...(overflowAttachment
      ? {
          overflow_attachment:
            overflowAttachment as unknown as GatewayDiscordDeliveryExecutionMetadata['overflow_attachment'],
        }
      : {}),
    ...(repair
      ? { repair: repair as unknown as GatewayDiscordDeliveryExecutionMetadata['repair'] }
      : {}),
  };
}

export function parseGatewayProviderActionParams(
  value: unknown,
  kind: GatewayProviderActionKind
): GatewayProviderActionParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositoryError('Gateway provider action params must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (kind === 'discord_thread_history') {
    const allowed = [
      'request_id',
      'initial_message_id',
      'through_message_id',
      'after_message_id',
      'limit',
    ];
    if (
      Object.keys(raw).some((key) => !allowed.includes(key)) ||
      !isCanonicalFullUuid(raw.request_id) ||
      !isDiscordSnowflake(raw.initial_message_id) ||
      !isDiscordSnowflake(raw.through_message_id) ||
      (raw.after_message_id !== undefined && !isDiscordSnowflake(raw.after_message_id)) ||
      !Number.isSafeInteger(raw.limit) ||
      Number(raw.limit) < 1 ||
      Number(raw.limit) > DISCORD_THREAD_HISTORY_MAX_LIMIT ||
      compareDiscordSnowflakes(raw.initial_message_id, raw.through_message_id) > 0 ||
      (typeof raw.after_message_id === 'string' &&
        (compareDiscordSnowflakes(raw.after_message_id, raw.initial_message_id) < 0 ||
          compareDiscordSnowflakes(raw.after_message_id, raw.through_message_id) > 0))
    ) {
      throw new RepositoryError('Discord thread history action params are invalid');
    }
    if (utf8Bytes(JSON.stringify(raw)) > GATEWAY_PROVIDER_ACTION_PARAMS_MAX_BYTES) {
      throw new RepositoryError('Gateway provider action params are too large');
    }
    return raw as unknown as GatewayDiscordThreadHistoryActionParams;
  }
  if (kind === 'discord_notice') {
    if (
      Object.keys(raw).length !== 1 ||
      ![
        'alignment_missing',
        'alignment_inactive',
        'mapped_owner_mismatch',
        'branch_access_denied',
        'fixed_identity_invalid',
      ].includes(String(raw.notice_code))
    ) {
      throw new RepositoryError('Discord routing notice code is invalid');
    }
    if (utf8Bytes(JSON.stringify(raw)) > GATEWAY_PROVIDER_ACTION_PARAMS_MAX_BYTES) {
      throw new RepositoryError('Gateway provider action params are too large');
    }
    return raw as unknown as GatewayDiscordNoticeActionParams;
  }
  if (kind === 'discord_progress') {
    const unknown = Object.keys(raw).filter(
      (key) =>
        key !== 'state' && key !== 'revision' && key !== 'tool_name' && key !== 'cleanup_reason'
    );
    if (unknown.length > 0) throw new RepositoryError('Unsupported gateway provider action param');
    if (!['queued', 'working', 'failed', 'done'].includes(String(raw.state))) {
      throw new RepositoryError('Discord progress state is invalid');
    }
    if (
      typeof raw.revision !== 'number' ||
      !Number.isSafeInteger(raw.revision) ||
      raw.revision <= 0 ||
      raw.revision > 2_147_483_647
    ) {
      throw new RepositoryError('Discord progress revision is invalid');
    }
    if (
      raw.tool_name !== undefined &&
      (typeof raw.tool_name !== 'string' ||
        !/^[A-Za-z0-9_.-]+$/.test(raw.tool_name) ||
        utf8Bytes(raw.tool_name) > 64)
    ) {
      throw new RepositoryError('Discord progress tool name is invalid');
    }
    if (raw.state !== 'working' && raw.tool_name !== undefined) {
      throw new RepositoryError('Only working progress may include a tool name');
    }
    if (
      raw.cleanup_reason !== undefined &&
      (raw.state !== 'done' || raw.cleanup_reason !== 'activity_expired')
    ) {
      throw new RepositoryError('Discord progress cleanup reason is invalid');
    }
    if (utf8Bytes(JSON.stringify(raw)) > GATEWAY_PROVIDER_ACTION_PARAMS_MAX_BYTES) {
      throw new RepositoryError('Gateway provider action params are too large');
    }
    return raw as unknown as GatewayDiscordProgressActionParams;
  }
  const unknown = Object.keys(raw).filter(
    (key) => key !== 'operation' && key !== 'provider_message_id'
  );
  if (unknown.length > 0) throw new RepositoryError('Unsupported gateway provider action param');
  if (raw.operation !== 'create' && raw.operation !== 'edit') {
    throw new RepositoryError('Gateway provider action operation must be create or edit');
  }
  if (raw.operation === 'create' && raw.provider_message_id !== undefined) {
    throw new RepositoryError('Create delivery cannot include a provider message ID');
  }
  if (raw.operation === 'edit') {
    if (typeof raw.provider_message_id !== 'string') {
      throw new RepositoryError('Edit delivery requires a provider message ID');
    }
    assertProviderActionBoundedNonEmpty(
      raw.provider_message_id,
      MAX_PROVIDER_COORDINATE_BYTES,
      'Provider message ID'
    );
    if (!PROVIDER_COORDINATE_PATTERN.test(raw.provider_message_id)) {
      throw new RepositoryError('Provider message ID has invalid characters');
    }
  }
  if (utf8Bytes(JSON.stringify(raw)) > GATEWAY_PROVIDER_ACTION_PARAMS_MAX_BYTES) {
    throw new RepositoryError('Gateway provider action params are too large');
  }
  return raw as unknown as GatewayDeliverMessageActionParams;
}

export function parseGatewayProviderActionResult(
  value: unknown,
  kind: GatewayProviderActionKind
): GatewayProviderActionResultMetadata | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositoryError('Invalid gateway provider action result metadata');
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== kind) throw new RepositoryError('Invalid gateway provider action result kind');
  if (kind === 'discord_thread_history') {
    const allowed = [
      'kind',
      'upload_ref',
      'sha256',
      'byte_length',
      'message_count',
      'has_more',
      'next_message_id',
    ];
    if (
      Object.keys(raw).some((key) => !allowed.includes(key)) ||
      typeof raw.upload_ref !== 'string' ||
      !/^upl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        raw.upload_ref
      ) ||
      typeof raw.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.sha256) ||
      !Number.isSafeInteger(raw.byte_length) ||
      Number(raw.byte_length) < 1 ||
      Number(raw.byte_length) > DISCORD_THREAD_HISTORY_SNAPSHOT_MAX_BYTES ||
      !Number.isSafeInteger(raw.message_count) ||
      Number(raw.message_count) < 0 ||
      Number(raw.message_count) > DISCORD_THREAD_HISTORY_MAX_LIMIT ||
      typeof raw.has_more !== 'boolean' ||
      (raw.next_message_id !== undefined && !isDiscordSnowflake(raw.next_message_id)) ||
      (raw.has_more === true && raw.next_message_id === undefined)
    ) {
      throw new RepositoryError('Invalid Discord thread history result metadata');
    }
  } else if (kind === 'deliver_message') {
    if (
      Object.keys(raw).length !== 2 ||
      typeof raw.provider_message_id !== 'string' ||
      !raw.provider_message_id.trim() ||
      utf8Bytes(raw.provider_message_id) > MAX_PROVIDER_COORDINATE_BYTES ||
      !PROVIDER_COORDINATE_PATTERN.test(raw.provider_message_id)
    ) {
      throw new RepositoryError('Invalid gateway provider action result metadata');
    }
  } else if (kind === 'discord_notice') {
    if (Object.keys(raw).length !== 2 || !isDiscordSnowflake(raw.provider_message_id)) {
      throw new RepositoryError('Invalid Discord notice result metadata');
    }
  } else if (raw.outcome === 'upserted') {
    if (Object.keys(raw).length !== 3 || !isDiscordSnowflake(raw.provider_message_id)) {
      throw new RepositoryError('Invalid Discord progress result metadata');
    }
  } else {
    const keys = Object.keys(raw);
    if (
      (raw.outcome !== 'cleaned' && raw.outcome !== 'noop') ||
      (keys.length !== 2 && keys.length !== 3) ||
      (raw.reason !== undefined && raw.reason !== 'activity_expired') ||
      (keys.length === 3 && raw.reason === undefined)
    ) {
      throw new RepositoryError('Invalid Discord progress result metadata');
    }
  }
  if (utf8Bytes(JSON.stringify(raw)) > GATEWAY_PROVIDER_ACTION_RESULT_MAX_BYTES) {
    throw new RepositoryError('Gateway provider action result metadata is too large');
  }
  return raw as unknown as GatewayProviderActionResultMetadata;
}

export function gatewayProviderActionFromRow(row: GatewayProviderActionRow): GatewayProviderAction {
  const params = parseGatewayProviderActionParams(row.params, row.kind);
  if (
    (row.kind === 'deliver_message' && row.drop_after !== null) ||
    (row.kind === 'discord_notice' && row.drop_after === null) ||
    (row.kind === 'discord_thread_history' && row.drop_after === null) ||
    (row.kind === 'discord_progress' &&
      ((params as GatewayDiscordProgressActionParams).state === 'done'
        ? row.drop_after !== null
        : row.drop_after === null))
  ) {
    throw new RepositoryError('Gateway provider action expiry shape is invalid');
  }
  return {
    id: row.id as GatewayProviderActionID,
    gateway_channel_id: row.gateway_channel_id as GatewayChannelID,
    channel_type: row.channel_type,
    provider_installation_id: row.provider_installation_id,
    provider_config_generation: row.provider_config_generation,
    kind: row.kind,
    idempotency_key: row.idempotency_key,
    thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID | null,
    session_id: row.session_id as SessionID | null,
    task_id: row.task_id as TaskID | null,
    message_id: row.message_id as MessageID | null,
    gateway_inbound_event_id: row.gateway_inbound_event_id as GatewayInboundEventID | null,
    params,
    status: row.status,
    attempts: row.attempts,
    not_before: new Date(row.not_before).toISOString(),
    drop_after: row.drop_after ? new Date(row.drop_after).toISOString() : null,
    claim_token: row.claim_token,
    claim_generation: row.claim_generation,
    claim_expires_at: row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null,
    claim_listener_token: row.claim_listener_token,
    claim_listener_generation: row.claim_listener_generation,
    claim_instance_id: row.claim_instance_id,
    claim_boot_id: row.claim_boot_id,
    last_error_code: row.last_error_code,
    execution_metadata: parseGatewayProviderActionExecutionMetadata(
      row.execution_metadata,
      row.kind
    ),
    result_metadata: parseGatewayProviderActionResult(row.result_metadata, row.kind),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    dead_lettered_at: row.dead_lettered_at ? new Date(row.dead_lettered_at).toISOString() : null,
    canceled_at: row.canceled_at ? new Date(row.canceled_at).toISOString() : null,
  };
}

export function gatewayProviderActionFromRawRow(
  row: Record<string, unknown>
): GatewayProviderAction {
  return gatewayProviderActionFromRow(row as unknown as GatewayProviderActionRow);
}

export function assertProviderActionSanitizedErrorCode(code: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
    throw new RepositoryError('Gateway provider action error code must be sanitized');
  }
}

export function assertGatewayProviderActionClaimInput(
  input: GatewayProviderActionClaimInput
): void {
  assertProviderActionCanonicalId(input.channelId, 'Gateway channel ID');
  assertProviderActionBoundedNonEmpty(
    input.listenerClaimToken,
    MAX_CLAIM_TOKEN_BYTES,
    'Listener claim token'
  );
  assertProviderActionBoundedNonEmpty(
    input.actionClaimToken,
    MAX_CLAIM_TOKEN_BYTES,
    'Action claim token'
  );
  assertProviderActionBoundedNonEmpty(input.identity.instanceId, 200, 'Action claim instance ID');
  assertProviderActionBoundedNonEmpty(input.identity.bootId, 200, 'Action claim boot ID');
  assertProviderActionPositiveInteger(
    input.listenerGeneration,
    Number.MAX_SAFE_INTEGER,
    'Listener generation'
  );
  assertProviderActionPositiveInteger(
    input.leaseMs,
    GATEWAY_PROVIDER_ACTION_MAX_LEASE_MS,
    'Gateway provider action lease'
  );
  assertProviderActionPositiveInteger(
    input.limit,
    GATEWAY_PROVIDER_ACTION_MAX_CLAIM_BATCH,
    'Gateway provider action claim batch'
  );
}
