/**
 * Soft validation: does this model ID look like it belongs to this agentic tool?
 *
 * Why "soft"?
 * -----------
 * Users can pin custom model strings (BYOK proxies, fine-tunes, dated
 * snapshots, internal aliases) — Agor deliberately accepts arbitrary model
 * IDs and lets the SDK be the final arbiter. We can't reject what we don't
 * recognize. But we *can* recognize the obvious mismatches: a session whose
 * `agentic_tool` is `codex` and whose `model_config.model` is `claude-opus-4-7`
 * is almost certainly a config bug (this is the bug this validator was
 * introduced to surface — see `resolve-child-session-config.ts`).
 *
 * The lint table is a compact prefix map keyed by family substring. A model
 * matches a tool when one of the tool's prefixes is found in the (lowercased)
 * model ID. Unknown models — those that don't match *any* prefix table —
 * pass silently: the user knows what they're doing, or the SDK will tell them.
 *
 * Copilot is the awkward case: Copilot proxies models from multiple
 * providers, so `claude-sonnet-4.6` is a perfectly valid Copilot model.
 * Copilot is therefore omitted from the prefix table — any model is plausible.
 */

import type { AgenticToolName } from '../types/agentic-tool.js';

/**
 * Family prefixes that identify a model as belonging to a specific tool.
 *
 * Match rule: a lowercased model ID is considered to belong to a tool when
 * *any* of the tool's prefixes appears anywhere in the lowercased ID. This
 * is intentionally fuzzy — Anthropic ships `claude-3-7-sonnet-latest`,
 * OpenAI ships `gpt-5.4-mini`, Google ships `gemini-2.5-flash`. Substring
 * containment is more permissive than `startsWith` (which would miss e.g.
 * `models/gemini-2.5-flash`) and tighter than running a regex.
 *
 * Copilot is intentionally absent: Copilot routes to upstream providers
 * (Anthropic, OpenAI, Google), so a Copilot session can legitimately use
 * any of these prefixes. We can't usefully lint it.
 *
 * To extend: add a prefix here. Keep entries lowercase.
 */
const TOOL_MODEL_PREFIXES: Partial<Record<AgenticToolName, readonly string[]>> = {
  'claude-code': ['claude-'],
  codex: ['gpt-', 'o1-', 'o1.', 'o3-', 'o3.', 'o4-', 'o4.', 'codex-'],
  gemini: ['gemini-'],
  // OpenCode is a multi-provider router — ship anything via `provider`.
  // Copilot routes to upstream providers — omitted.
};

/** Result of a model/tool match check. `null` means "no opinion". */
export type ModelToolMatch =
  | { match: 'ok'; tool: AgenticToolName; model: string }
  | { match: 'mismatch'; tool: AgenticToolName; model: string; looksLike: AgenticToolName }
  | { match: 'unknown'; tool: AgenticToolName; model: string };

/**
 * Inspect a model/tool pair without rejecting it.
 *
 * Returns:
 * - `ok` when the model ID matches one of `tool`'s known prefixes.
 * - `mismatch` when the model ID matches a *different* tool's prefixes
 *   (this is the cross-tool spawn bug — surfaces "Codex session got a
 *   Claude model" before the SDK errors).
 * - `unknown` when the model ID doesn't match any known prefix. Custom
 *   strings, internal aliases, BYOK proxies — pass silently.
 */
export function lintModelToolMatch(
  model: string | undefined | null,
  tool: AgenticToolName
): ModelToolMatch | null {
  if (!model) return null;
  const lower = model.toLowerCase();

  // 1. Does it match the *requested* tool? Then we're happy.
  const requestedPrefixes = TOOL_MODEL_PREFIXES[tool];
  if (requestedPrefixes?.some((p) => lower.includes(p))) {
    return { match: 'ok', tool, model };
  }

  // 2. Does it match some *other* tool? Then it's a likely mismatch.
  for (const [otherTool, prefixes] of Object.entries(TOOL_MODEL_PREFIXES) as Array<
    [AgenticToolName, readonly string[]]
  >) {
    if (otherTool === tool) continue;
    if (prefixes.some((p) => lower.includes(p))) {
      return { match: 'mismatch', tool, model, looksLike: otherTool };
    }
  }

  // 3. Doesn't match anything we know. No opinion.
  return { match: 'unknown', tool, model };
}

/**
 * Human-readable warning string for a `mismatch` result. Returns `undefined`
 * for `ok` / `unknown` / `null` so callers can guard with `if (msg)` and
 * propagate the warning to logs / API responses uniformly.
 */
export function formatModelToolMismatchWarning(result: ModelToolMatch | null): string | undefined {
  if (!result || result.match !== 'mismatch') return undefined;
  return (
    `Model "${result.model}" looks like a ${result.looksLike} model but the session ` +
    `is configured for ${result.tool}. Proceeding with the user-supplied value, but the ` +
    `SDK may reject it. Set a per-tool default in user preferences, or pass an explicit ` +
    `modelConfig to silence this warning.`
  );
}
