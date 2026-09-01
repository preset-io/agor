/**
 * Runtime projections for provider SDK results that cross the executor/daemon
 * boundary. Provider SDK values are external input even when their TypeScript
 * declarations are closed: extension properties, strings, and object keys can
 * contain reflected credentials or response bodies.
 */

import type { ContextUsageSnapshot, Task } from './types/task.js';

export const SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE =
  'The provider ended the request without returning a model response. Retry the prompt.';

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

function ownDataValue(value: unknown, field: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
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
