/**
 * Closed Codex error classification (`CodexErrorInfo`, codex-rs/protocol).
 *
 * Codex core attaches this enum to every fatal turn error, and app-server v2
 * forwards it as `TurnError.codexErrorInfo`. `codex exec --json` (what
 * `@openai/codex-sdk` drives) currently drops it and emits `{message}` only —
 * openai/codex#22570 and #36562, still open as of SDK 0.157.0 / 0.159.0-alpha.2.
 * Until it is forwarded, every reader here returns undefined and callers keep
 * their generic copy.
 *
 * This reads ONLY the closed discriminator (and its numeric HTTP status). It never
 * reads `message` or any other prose, so the result is safe for operational logs
 * and fixed user-facing copy. The wire field name/casing is not settled upstream,
 * so both core (`snake_case`) and app-server v2 (`camelCase`) shapes are accepted.
 */
export const CODEX_ERROR_INFO_VARIANTS = [
  'context_window_exceeded',
  'session_budget_exceeded',
  'usage_limit_exceeded',
  'rate_limit_exceeded',
  'flex_unavailable',
  'server_overloaded',
  'cyber_policy',
  'bio_policy',
  'misalignment_policy_violation',
  'http_connection_failed',
  'response_stream_connection_failed',
  'internal_server_error',
  'unauthorized',
  'bad_request',
  'invalid_prompt',
  'sandbox_error',
  'response_stream_disconnected',
  'response_too_many_failed_attempts',
  'active_turn_not_steerable',
  'thread_rollback_failed',
  'other',
] as const;

export type CodexErrorInfoVariant = (typeof CODEX_ERROR_INFO_VARIANTS)[number];

export interface CodexErrorInfo {
  variant: CodexErrorInfoVariant;
  /** Upstream HTTP status, carried by the connection/stream variants. */
  httpStatus?: number;
}

// Casing-insensitive lookup: `usage_limit_exceeded` / `usageLimitExceeded`.
const VARIANT_BY_KEY = new Map<string, CodexErrorInfoVariant>(
  CODEX_ERROR_INFO_VARIANTS.map((variant) => [variant.replace(/_/g, ''), variant])
);

function ownData(value: unknown, property: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function variantFor(key: unknown): CodexErrorInfoVariant | undefined {
  if (typeof key !== 'string' || key.length > 64) return undefined;
  return VARIANT_BY_KEY.get(key.replace(/_/g, '').toLowerCase());
}

function httpStatusFrom(payload: unknown): number | undefined {
  const value = ownData(payload, 'http_status_code') ?? ownData(payload, 'httpStatusCode');
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function parseErrorInfo(raw: unknown): CodexErrorInfo | undefined {
  // Unit variants serialize as a bare string.
  const unit = variantFor(raw);
  if (unit) return { variant: unit };
  // Struct variants serialize as a single-key object: { variant: { http_status_code } }.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  let keys: string[];
  try {
    keys = Object.keys(raw);
  } catch {
    return undefined;
  }
  if (keys.length !== 1) return undefined;
  const variant = variantFor(keys[0]);
  if (!variant) return undefined;
  const httpStatus = httpStatusFrom(ownData(raw, keys[0]));
  return httpStatus !== undefined ? { variant, httpStatus } : { variant };
}

/**
 * Read the closed error info from a Codex `turn.failed` event, its `error`
 * payload, or a top-level `{type:'error'}` event. Never invokes accessors.
 */
export function readCodexErrorInfo(source: unknown): CodexErrorInfo | undefined {
  for (const holder of [source, ownData(source, 'error')]) {
    const raw = ownData(holder, 'codex_error_info') ?? ownData(holder, 'codexErrorInfo');
    const parsed = raw === undefined ? undefined : parseErrorInfo(raw);
    if (parsed) return parsed;
  }
  return undefined;
}

const EXPLANATIONS: Partial<Record<CodexErrorInfoVariant, string>> = {
  context_window_exceeded:
    "the conversation no longer fits in the model's context window. Start a new session (or fork from an earlier point) and retry.",
  session_budget_exceeded:
    'this Codex session reached its token budget. Start a new session to continue.',
  usage_limit_exceeded:
    'the Codex account reached its usage limit. Wait for the limit to reset or review the plan/billing for the Codex credentials, then retry.',
  rate_limit_exceeded: 'the model provider rate-limited the request. Wait a moment and retry.',
  flex_unavailable:
    'flex processing is currently unavailable for this model. Retry later or switch service tier.',
  server_overloaded:
    'the selected model is at capacity. Retry shortly or choose a different model.',
  internal_server_error:
    'the model provider returned a server error. Retry shortly; if it continues, try a different model.',
  cyber_policy:
    'the model provider flagged this request under its cybersecurity policy. Rephrase the request or start a new session; retrying the same prompt will fail again.',
  bio_policy:
    'the model provider flagged this request under its biosafety policy. Rephrase the request or start a new session; retrying the same prompt will fail again.',
  misalignment_policy_violation:
    'the model provider blocked this request under its usage policy. Rephrase the request or start a new session.',
  invalid_prompt:
    'the model provider rejected the prompt as invalid. Rephrase the request or start a new session.',
  unauthorized:
    'the model provider rejected the Codex credentials. Re-authenticate Codex (API key or ChatGPT login) in Settings, then retry.',
  bad_request:
    'the model provider rejected the request as invalid. Retry; if it keeps failing, start a new session.',
  sandbox_error:
    'Codex could not set up its command sandbox. Ask an administrator to review the Codex runtime configuration.',
  http_connection_failed:
    'Codex could not connect to the model provider. Check connectivity and retry.',
  response_stream_connection_failed:
    'Codex could not open a response stream from the model provider. Check connectivity and retry.',
  response_stream_disconnected:
    'the response stream from the model provider disconnected before completion. Retry the prompt.',
  response_too_many_failed_attempts:
    'Codex exhausted its retries against the model provider. Wait a moment and retry.',
};

/**
 * Fixed user-facing copy for a classified failure, or undefined when there is no
 * specific explanation (callers keep their generic message). Only closed values
 * are interpolated.
 */
export function describeCodexErrorInfo(
  lead: string,
  info: CodexErrorInfo | undefined
): string | undefined {
  const explanation = info ? EXPLANATIONS[info.variant] : undefined;
  if (!info || !explanation) return undefined;
  const status = info.httpStatus !== undefined ? ` (HTTP ${info.httpStatus})` : '';
  return `${lead}${status}: ${explanation}`;
}
