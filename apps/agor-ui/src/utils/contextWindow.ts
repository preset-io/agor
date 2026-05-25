/**
 * Context Window Utilities
 *
 * Helpers for calculating and rendering context window progress indicators.
 */

import type { ContextUsageSnapshot } from '@agor/core/types';

/**
 * Get color for context window usage based on percentage
 *
 * @param percentage - Usage percentage (0-100)
 * @returns rgba color string
 */
export function getContextWindowColor(percentage: number): string {
  if (percentage < 50) {
    return 'rgba(82, 196, 26, 0.12)'; // Green
  }
  if (percentage < 80) {
    return 'rgba(250, 173, 20, 0.12)'; // Orange
  }
  return 'rgba(255, 77, 79, 0.12)'; // Red
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
  snapshot?: ContextUsageSnapshot | null
): string | undefined {
  if (!snapshot && (!used || !limit)) return undefined;

  const percentage = resolveContextWindowPercentage(used, limit, snapshot);
  const color = getContextWindowColor(percentage);

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
