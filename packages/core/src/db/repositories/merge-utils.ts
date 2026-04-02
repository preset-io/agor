/**
 * Deep merge utilities for repository updates
 *
 * Handles partial nested updates by deep-merging objects while replacing arrays and primitives.
 * This prevents shallow merge from losing nested fields during partial updates.
 */

/**
 * Check if value is a plain object (not array, null, Date, etc.)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Deep merge two objects
 *
 * Strategy:
 * - Objects: Recursively merge properties
 * - Arrays: Replace (don't concatenate)
 * - Primitives: Replace
 * - undefined in source: Skip (preserve target value)
 * - null in source: Replace (explicit null assignment)
 *
 * @param target - Base object
 * @param source - Updates to apply
 * @returns Merged object (new object, doesn't mutate inputs)
 *
 * @example
 * ```typescript
 * const current = { permission_config: { mode: 'auto', allowedTools: [] } };
 * const update = { permission_config: { allowedTools: ['Bash'] } };
 * const merged = deepMerge(current, update);
 * // Result: { permission_config: { mode: 'auto', allowedTools: ['Bash'] } }
 * // mode is preserved! ✅
 * ```
 */
export function deepMerge<T>(target: T, source: Partial<T>): T {
  // Start with shallow copy of target
  const result = { ...target } as T;

  // Iterate over source properties
  for (const key in source) {
    if (!Object.hasOwn(source, key)) {
      continue; // Skip inherited properties
    }

    const sourceValue = source[key];
    const targetValue = target[key];

    // undefined in source = skip (preserve target)
    if (sourceValue === undefined) {
      continue;
    }

    // null in source = explicit null assignment
    if (sourceValue === null) {
      (result as Record<string, unknown>)[key] = null;
      continue;
    }

    // Array in source = replace (don't concatenate)
    if (Array.isArray(sourceValue)) {
      (result as Record<string, unknown>)[key] = sourceValue;
      continue;
    }

    // Plain object in source = deep merge if target is also plain object
    if (isPlainObject(sourceValue)) {
      if (isPlainObject(targetValue)) {
        // Both are plain objects - recursively merge
        (result as Record<string, unknown>)[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        );
      } else {
        // Target is not an object - replace with source
        (result as Record<string, unknown>)[key] = sourceValue;
      }
      continue;
    }

    // Primitive in source = replace
    (result as Record<string, unknown>)[key] = sourceValue;
  }

  return result;
}
