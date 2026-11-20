/**
 * Runtime projections for provider SDK results that cross the executor/daemon
 * boundary. Provider SDK values are external input even when their TypeScript
 * declarations are closed: extension properties, strings, and object keys can
 * contain reflected credentials or response bodies.
 */

import type { ContextUsageSnapshot, Task } from './types/task.js';

import {
  SAFE_MISSING_PROVIDER_RESULT_MESSAGE,
  SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
} from './types/turn-failure-messages.js';

export { SAFE_MISSING_PROVIDER_RESULT_MESSAGE, SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE };

export type SafeNormalizedSdkResponse = NonNullable<Task['normalized_sdk_response']>;

export type SafeClaudeResultSubtype =
  | 'success'
  | 'error_during_execution'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries'
  | 'unknown';

export interface SafeClaudeResultResponse {
  type: 'result';
  subtype: SafeClaudeResultSubtype;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface SafeClaudePermissionDenialMetadata {
  tool_name?: string;
  tool_use_id?: string;
  agent_id?: string;
  decision_reason_type?: string;
}

const MAX_PERMISSION_DENIAL_FIELD_LENGTH = 256;
const MAX_PERMISSION_DENIAL_REASON_LENGTH = 512;

function ownDataValue(value: unknown, field: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedOwnString(value: unknown, field: string, maxLength: number): string | undefined {
  const raw = ownDataValue(value, field);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength).trimEnd() : trimmed;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safePercentage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function safeModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

function safeClaudeResultSubtype(value: unknown): SafeClaudeResultSubtype {
  return value === 'success' ||
    value === 'error_during_execution' ||
    value === 'error_max_turns' ||
    value === 'error_max_budget_usd' ||
    value === 'error_max_structured_output_retries'
    ? value
    : 'unknown';
}

function projectClaudeUsage(value: unknown): SafeClaudeResultResponse['usage'] | undefined {
  const inputTokens = safeCount(ownDataValue(value, 'input_tokens'));
  const outputTokens = safeCount(ownDataValue(value, 'output_tokens'));
  const cacheReadTokens = safeCount(ownDataValue(value, 'cache_read_input_tokens'));
  const cacheCreationTokens = safeCount(ownDataValue(value, 'cache_creation_input_tokens'));
  const projected = {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cache_read_input_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined
      ? { cache_creation_input_tokens: cacheCreationTokens }
      : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Produce the only Claude result shape allowed in Task persistence/realtime.
 * Raw result/error prose, permission data, UUIDs, modelUsage keys, and unknown
 * SDK extensions are deliberately excluded. The aggregate `usage` object is
 * rebuilt field-by-field from finite counters; the provider object is never
 * copied or spread.
 */
export function projectClaudeResultResponse(value: unknown): SafeClaudeResultResponse | undefined {
  if (ownDataValue(value, 'type') !== 'result') return undefined;

  const subtype = safeClaudeResultSubtype(ownDataValue(value, 'subtype'));
  const durationMs = finiteNonNegative(ownDataValue(value, 'duration_ms'));
  const durationApiMs = finiteNonNegative(ownDataValue(value, 'duration_api_ms'));
  const isError = ownDataValue(value, 'is_error');
  const numTurns = safeCount(ownDataValue(value, 'num_turns'));
  const totalCostUsd = finiteNonNegative(ownDataValue(value, 'total_cost_usd'));
  const usage = projectClaudeUsage(ownDataValue(value, 'usage'));

  return {
    type: 'result',
    subtype,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(durationApiMs !== undefined ? { duration_api_ms: durationApiMs } : {}),
    ...(typeof isError === 'boolean' ? { is_error: isError } : {}),
    ...(numTurns !== undefined ? { num_turns: numTurns } : {}),
    ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * The closed failure code of a non-success Claude result, safe to store as
 * diagnostic detail. Provider prose (`errors[]`, `result`) is never read here.
 */
export function claudeResultFailureCode(value: unknown): string | undefined {
  const result = projectClaudeResultResponse(value);
  if (!result) return undefined;
  if (result.subtype !== 'success' && result.subtype !== 'unknown') return result.subtype;
  return result.is_error === true ? 'is_error' : undefined;
}

/**
 * Close an SDK context response to the three canonical scalar fields used by
 * Task/UI state. Claude's richer response includes memory paths, MCP tool
 * names, prompt sections, and future extension objects; none cross this
 * boundary. Accessors and inherited fields are never evaluated.
 */
export function projectContextUsageSnapshot(value: unknown): ContextUsageSnapshot | undefined {
  const totalTokens = safeCount(ownDataValue(value, 'totalTokens'));
  const maxTokens = safeCount(ownDataValue(value, 'maxTokens'));
  const percentage = safePercentage(ownDataValue(value, 'percentage'));
  if (totalTokens === undefined || maxTokens === undefined || percentage === undefined) {
    return undefined;
  }
  return { totalTokens, maxTokens, percentage };
}

function projectNormalizedTokenUsage(
  value: unknown
): SafeNormalizedSdkResponse['tokenUsage'] | undefined {
  const inputTokens = safeCount(ownDataValue(value, 'inputTokens'));
  const outputTokens = safeCount(ownDataValue(value, 'outputTokens'));
  const totalTokens = safeCount(ownDataValue(value, 'totalTokens'));
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  const cacheReadTokens = safeCount(ownDataValue(value, 'cacheReadTokens'));
  const cacheCreationTokens = safeCount(ownDataValue(value, 'cacheCreationTokens'));
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
}

/**
 * Runtime projection for the complete normalized SDK response persisted on a
 * Task. This is a separate trust boundary from raw result projection: an old
 * or compromised executor can patch normalized data without sending a raw
 * response. Every nested object is rebuilt from allowlisted scalar fields;
 * no provider/executor object is spread or retained by reference.
 */
export function projectNormalizedSdkResponse(
  value: unknown
): SafeNormalizedSdkResponse | undefined {
  const tokenUsage = projectNormalizedTokenUsage(ownDataValue(value, 'tokenUsage'));
  if (!tokenUsage) return undefined;

  const contextWindowLimit = safeCount(ownDataValue(value, 'contextWindowLimit'));
  const costUsd = finiteNonNegative(ownDataValue(value, 'costUsd'));
  const primaryModel = safeModel(ownDataValue(value, 'primaryModel'));
  const durationMs = finiteNonNegative(ownDataValue(value, 'durationMs'));
  const contextUsageSnapshot = projectContextUsageSnapshot(
    ownDataValue(value, 'contextUsageSnapshot')
  );

  return {
    tokenUsage,
    ...(contextWindowLimit !== undefined ? { contextWindowLimit } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(primaryModel !== undefined ? { primaryModel } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(contextUsageSnapshot ? { contextUsageSnapshot } : {}),
  };
}

/**
 * Closed allowlist projection for Claude permission-denial metadata persisted on
 * `sdk_event` blocks. Excludes `tool_input`, denial prose, session/event UUIDs,
 * and unknown extension properties; never evaluates accessors or prototypes.
 */
export function projectClaudePermissionDenialMetadata(
  value: unknown
): SafeClaudePermissionDenialMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const toolName = boundedOwnString(value, 'tool_name', MAX_PERMISSION_DENIAL_FIELD_LENGTH);
  const toolUseId = boundedOwnString(value, 'tool_use_id', MAX_PERMISSION_DENIAL_FIELD_LENGTH);
  const agentId = boundedOwnString(value, 'agent_id', MAX_PERMISSION_DENIAL_FIELD_LENGTH);
  const decisionReasonType = boundedOwnString(
    value,
    'decision_reason_type',
    MAX_PERMISSION_DENIAL_FIELD_LENGTH
  );

  const projected: SafeClaudePermissionDenialMetadata = {
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
    ...(decisionReasonType !== undefined ? { decision_reason_type: decisionReasonType } : {}),
  };

  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Read bounded human-readable denial reason fields from an SDK permission-denied
 * message without invoking accessors or inherited properties.
 */
export function projectClaudePermissionDenialReason(value: unknown): {
  message?: string;
  decision_reason?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const message = boundedOwnString(value, 'message', MAX_PERMISSION_DENIAL_REASON_LENGTH);
  const decisionReason = boundedOwnString(
    value,
    'decision_reason',
    MAX_PERMISSION_DENIAL_REASON_LENGTH
  );
  return {
    ...(message !== undefined ? { message } : {}),
    ...(decisionReason !== undefined ? { decision_reason: decisionReason } : {}),
  };
}

/**
 * Project a raw `permission_denials` list into allowlisted metadata entries,
 * skipping malformed or empty elements.
 */
export function projectClaudePermissionDenials(
  entries: unknown
): SafeClaudePermissionDenialMetadata[] {
  if (!Array.isArray(entries)) return [];
  const projected: SafeClaudePermissionDenialMetadata[] = [];
  for (const entry of entries) {
    const metadata = projectClaudePermissionDenialMetadata(entry);
    if (metadata) projected.push(metadata);
  }
  return projected;
}

/**
 * Safely read and project `permission_denials` from an SDK result record.
 */
export function projectClaudeResultPermissionDenials(
  result: unknown
): SafeClaudePermissionDenialMetadata[] {
  return projectClaudePermissionDenials(ownDataValue(result, 'permission_denials'));
}
