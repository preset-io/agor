/**
 * SDK-response shapes for the Claude Code CLI adapter.
 *
 * Lives in `@agor/core/claude-cli/` (not the daemon service file) so the
 * shapes can be referenced by tests, type-only consumers in the UI, and
 * any future tool that ingests CLI task analytics — without pulling in
 * the daemon's runtime wiring.
 *
 * Field names are kept in **lockstep** with two existing SDK-side types:
 *   - `SDKResultMessage` from `@anthropic-ai/claude-agent-sdk` (mirrored
 *     by `ClaudeCliRawSdkResponse`)
 *   - `NormalizedSdkData` in
 *     `packages/executor/src/sdk-handlers/base/normalizer.interface.ts`
 *     (mirrored by `ClaudeCliNormalizedSdkResponse`)
 *
 * We don't import either of those — the daemon shouldn't depend on the
 * executor package, and the SDK type is for SDK sessions, not CLI ones —
 * but if either ever drifts, the existing `ClaudeCodeNormalizer`
 * (executor) will start producing different shapes for SDK vs CLI tasks
 * and downstream cost/token cards will diverge. The deliberate type
 * duplication is documented; lockstep maintenance is the contract.
 */

/**
 * One model's slice of the per-turn rollup. Field names match the SDK's
 * `ClaudeModelUsage` so the same UI code reads both.
 */
export interface ClaudeCliModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextWindow: number;
}

/**
 * What we persist to `task.data.raw_sdk_response` for CLI-driven turns.
 *
 * Mirrors `SDKResultMessage` — same `modelUsage` / `usage` /
 * `duration_ms` / `total_cost_usd` fields — so the existing
 * `ClaudeCodeNormalizer` reads CLI turns the same as SDK turns.
 *
 * `_cli_provenance` is the one CLI-specific addition: a debugging
 * breadcrumb so "did we miss `end_turn`?" investigations don't have to
 * re-read the JSONL. Nothing in the UI depends on it; structurally
 * additive.
 */
export interface ClaudeCliRawSdkResponse {
  type: 'result';
  subtype: 'success';
  session_id: string;
  duration_ms: number;
  total_cost_usd: number | undefined;
  modelUsage: Record<string, ClaudeCliModelUsageEntry>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  _cli_provenance: {
    adapter: 'claude-code-cli';
    assistantTurns: number;
    lastAssistantSnapshot: unknown;
  };
}

/**
 * Normalized rollup we persist to `task.data.normalized_sdk_response`.
 * Shape matches `NormalizedSdkData` (see file-level comment).
 */
export interface ClaudeCliNormalizedSdkResponse {
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  contextWindowLimit: number;
  costUsd: number | undefined;
  primaryModel: string | undefined;
  durationMs: number;
}
