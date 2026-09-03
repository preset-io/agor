export const MCP_RUNTIME_HINT_TASK_BUDGET = 500;

// One bounded fanout can legitimately wake 500 distinct executors in the same
// ten-second window. Keep independent headroom instead of making the limiter's
// key capacity nearly identical to that normal burst.
export const MCP_REFRESH_LIMITER_KEY_CAP = 1_024;
const MCP_REFRESH_LIMITER_TENANT_CAP = 4_096;
const MCP_REFRESH_LIMITER_WINDOW_MS = 10_000;
const MCP_REFRESH_LIMITER_ATTEMPTS_PER_KEY = 5;

export type MCPRefreshAttemptState = Map<string, Map<string, number[]>>;
export type MCPRefreshLimitOutcome =
  | 'allowed'
  | 'tenant_capacity'
  | 'key_capacity'
  | 'rate_limited';

/**
 * Process-local availability limiter. Durable exact retries bypass it because
 * the Task-row claim remains the authoritative idempotency fence across HA.
 */
export function consumeMcpRefreshAttempt(
  state: MCPRefreshAttemptState,
  input: {
    tenantId: string;
    authorityKey: string;
    now: number;
    isExactDurableRetry: boolean;
  }
): MCPRefreshLimitOutcome {
  if (input.isExactDurableRetry) return 'allowed';

  if (!state.has(input.tenantId) && state.size >= MCP_REFRESH_LIMITER_TENANT_CAP) {
    for (const [candidateTenant, buckets] of state) {
      const hasRecent = [...buckets.values()].some((attempts) =>
        attempts.some((at) => input.now - at < MCP_REFRESH_LIMITER_WINDOW_MS)
      );
      if (!hasRecent) state.delete(candidateTenant);
    }
    if (state.size >= MCP_REFRESH_LIMITER_TENANT_CAP) return 'tenant_capacity';
  }

  const tenantAttempts = state.get(input.tenantId) ?? new Map<string, number[]>();
  if (!state.has(input.tenantId)) state.set(input.tenantId, tenantAttempts);
  if (
    !tenantAttempts.has(input.authorityKey) &&
    tenantAttempts.size >= MCP_REFRESH_LIMITER_KEY_CAP
  ) {
    for (const [key, attempts] of tenantAttempts) {
      if (attempts.every((at) => input.now - at >= MCP_REFRESH_LIMITER_WINDOW_MS)) {
        tenantAttempts.delete(key);
      }
    }
    if (tenantAttempts.size >= MCP_REFRESH_LIMITER_KEY_CAP) return 'key_capacity';
  }

  const recent = (tenantAttempts.get(input.authorityKey) ?? []).filter(
    (at) => input.now - at < MCP_REFRESH_LIMITER_WINDOW_MS
  );
  if (recent.length >= MCP_REFRESH_LIMITER_ATTEMPTS_PER_KEY) return 'rate_limited';
  recent.push(input.now);
  tenantAttempts.set(input.authorityKey, recent);
  return 'allowed';
}
