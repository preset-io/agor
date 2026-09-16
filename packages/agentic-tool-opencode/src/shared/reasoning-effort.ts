import type { EffortLevel } from '@agor/core/types';

export const OPENCODE_AGOR_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[];

/**
 * Projects OpenCode's native variant map to the only names Agor may expose.
 * Variant bodies are deliberately ignored because they may contain provider
 * configuration. Missing/non-map input remains unknown; an empty map becomes
 * a known empty list.
 */
export function filterOpenCodeReasoningEffortLevels(variants: unknown): EffortLevel[] | undefined {
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return undefined;
  return OPENCODE_AGOR_EFFORT_LEVELS.filter((level) => Object.hasOwn(variants, level));
}
