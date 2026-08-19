const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/**
 * Derive a compact, versioned display name from a model id.
 *
 * Handles both single-segment versions (`claude-opus-5` -> `opus-5`) and
 * two-segment major.minor versions (`claude-opus-4-8` -> `opus-4.8`). Ids may
 * carry suffixes such as `[1m]` (e.g. `claude-sonnet-4-5[1m]`) which do not
 * interfere with matching. Falls back to the bare family name only when the id
 * has no version digits, and returns the raw id for unknown families.
 */
export function getModelDisplayName(modelId: string): string {
  for (const family of MODEL_FAMILIES) {
    if (!modelId.includes(family)) continue;
    const match = modelId.match(new RegExp(`${family}-(\\d+)(?:-(\\d+))?`));
    if (!match) return family;
    return match[2] ? `${family}-${match[1]}.${match[2]}` : `${family}-${match[1]}`;
  }

  return modelId;
}
