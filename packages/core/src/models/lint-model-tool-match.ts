/**
 * Soft validation: does this model ID look like it belongs to this agentic tool?
 *
 * Users can pin custom model strings (BYOK proxies, fine-tunes, dated snapshots,
 * internal aliases), so we never reject — we only warn on the obvious mismatch
 * a `codex` session being handed a `claude-*` model. The lint table is a
 * compact prefix map; tools that proxy upstream providers (Copilot, OpenCode)
 * are skipped entirely because any namespace is plausible.
 */

import type { AgenticToolName } from '../types/agentic-tool.js';

/**
 * Family prefixes that identify a model as belonging to a specific tool.
 * Match rule: the (normalized) model ID `startsWith` one of the tool's
 * prefixes. Normalization strips a leading `models/` (Google's API form)
 * so e.g. `models/gemini-2.5-flash` matches `gemini-`. Keep entries lowercase.
 *
 * To extend: add a prefix here.
 */
const TOOL_MODEL_PREFIXES: Partial<Record<AgenticToolName, readonly string[]>> = {
  'claude-code': ['claude-'],
  codex: ['gpt-', 'o1-', 'o1.', 'o3-', 'o3.', 'o4-', 'o4.', 'codex-'],
  gemini: ['gemini-'],
};

/**
 * Tools that proxy/route to upstream providers (Anthropic, OpenAI, Google, ...).
 * A `claude-*` model on a Copilot session is legitimate — there is no useful
 * lint to perform. The validator returns `null` (no opinion) for these.
 */
const UNOPINIONATED_TOOLS: ReadonlySet<AgenticToolName> = new Set(['copilot', 'opencode']);

/** Result of a model/tool match check. `null` means "no opinion". */
export type ModelToolMatch =
  | { match: 'ok'; tool: AgenticToolName; model: string }
  | { match: 'mismatch'; tool: AgenticToolName; model: string; looksLike: AgenticToolName }
  | { match: 'unknown'; tool: AgenticToolName; model: string };

/**
 * Inspect a model/tool pair without rejecting it.
 *
 * Returns:
 * - `null` when there's no opinion to give (no model, or the tool routes
 *   to upstream providers and any model is plausible).
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
  if (UNOPINIONATED_TOOLS.has(tool)) return null;
  const normalized = normalizeModelId(model);

  const requestedPrefixes = TOOL_MODEL_PREFIXES[tool];
  if (requestedPrefixes?.some((p) => normalized.startsWith(p))) {
    return { match: 'ok', tool, model };
  }

  for (const [otherTool, prefixes] of Object.entries(TOOL_MODEL_PREFIXES) as Array<
    [AgenticToolName, readonly string[]]
  >) {
    if (otherTool === tool) continue;
    if (prefixes.some((p) => normalized.startsWith(p))) {
      return { match: 'mismatch', tool, model, looksLike: otherTool };
    }
  }

  return { match: 'unknown', tool, model };
}

/**
 * Lowercase + strip the Google `models/` prefix. Anchored matching uses this
 * normalized form so wrapped IDs still match family prefixes correctly.
 */
function normalizeModelId(model: string): string {
  const lower = model.toLowerCase();
  return lower.startsWith('models/') ? lower.slice('models/'.length) : lower;
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
