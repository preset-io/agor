/**
 * Context Window Utilities
 *
 * Helpers for calculating and rendering context window progress indicators.
 */

import type { ContextUsageSnapshot } from '@agor/core/types';

export interface ContextWindowColors {
  normal: string;
  warning: string;
  critical: string;
}

/**
 * Get color for context window usage based on percentage
 *
 * @param percentage - Usage percentage (0-100)
 * @param colors - Theme-derived semantic surface colors
 * @returns the semantic color for the usage band
 */
export function getContextWindowColor(percentage: number, colors: ContextWindowColors): string {
  if (percentage < 50) {
    return colors.normal;
  }
  if (percentage < 80) {
    return colors.warning;
  }
  return colors.critical;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Resolve the percentage to display for a context-window indicator.
 *
 * When the executor produced an authoritative `ContextUsageSnapshot`
 * (via the SDK or CLI protocol — e.g. Codex applies a baseline-adjusted
 * formula that does not equal `used / limit`), use its `percentage`
 * verbatim so the UI matches the agent's own display. Otherwise fall
 * back to the raw `used / limit` ratio.
 */
export function resolveContextWindowPercentage(
  used: number | undefined,
  limit: number | undefined,
  snapshot?: ContextUsageSnapshot | null
): number {
  if (snapshot && Number.isFinite(snapshot.percentage)) {
    return clampPercentage(snapshot.percentage);
  }
  if (!used || !limit) return 0;
  return clampPercentage((used / limit) * 100);
}

/**
 * Create a horizontal gradient background for context window progress.
 *
 * Prefers the executor-supplied `ContextUsageSnapshot.percentage` when
 * available so the gradient stays in lockstep with the displayed pill
 * label.
 */
export function getContextWindowGradient(
  used: number | undefined,
  limit: number | undefined,
  snapshot: ContextUsageSnapshot | null | undefined,
  colors: ContextWindowColors
): string | undefined {
  if (!snapshot && (!used || !limit)) return undefined;

  const percentage = resolveContextWindowPercentage(used, limit, snapshot);
  const color = getContextWindowColor(percentage, colors);

  return `linear-gradient(to right, ${color} ${percentage}%, transparent ${percentage}%)`;
}

/**
 * Calculate context window usage percentage.
 *
 * @deprecated Prefer `resolveContextWindowPercentage` so an authoritative
 * `ContextUsageSnapshot.percentage` is honored when present. Kept for
 * callers that genuinely want the raw `used / limit` ratio.
 */
export function getContextWindowPercentage(
  used: number | undefined,
  limit: number | undefined
): number {
  return resolveContextWindowPercentage(used, limit, null);
}

/**
 * One-line summary of a turn's context-window usage, for the tooltip on the
 * usage rule and its label.
 *
 * Token counts use `toLocaleString`, the same formatting the breakdown popover
 * in `ContextWindowPill` prints, and the percentage comes from
 * `resolveContextWindowPercentage` so the tooltip cannot disagree with the
 * number beside it.
 *
 * An executor that reported only a percentage — a snapshot with no absolute
 * counts, or a limit nobody knows — gets the short form rather than a total
 * of zero.
 */
export function formatContextWindowSummary(
  used: number | undefined,
  limit: number | undefined,
  snapshot?: ContextUsageSnapshot | null
): string {
  const percentage = Math.round(resolveContextWindowPercentage(used, limit, snapshot));
  const effectiveUsed = snapshot?.totalTokens ?? used;
  const effectiveLimit = snapshot?.maxTokens ?? limit;

  if (!effectiveUsed || !effectiveLimit) return `Context window · ${percentage}% used`;
  return `Context window · ${effectiveUsed.toLocaleString()} / ${effectiveLimit.toLocaleString()} tokens (${percentage}%)`;
}
