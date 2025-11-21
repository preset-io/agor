/**
 * Slug Generation Utilities
 *
 * Generate URL-friendly slugs from names with conflict handling.
 * Used for beautiful board URLs: /b/my-board instead of /b/550e8400
 */

/**
 * Generate a URL-friendly slug from a string.
 *
 * - Converts to lowercase
 * - Replaces spaces and special characters with hyphens
 * - Removes consecutive hyphens
 * - Trims hyphens from start/end
 * - Limits length to 64 characters
 * - Returns empty string if no alphanumeric characters remain
 *
 * @param name - The name to slugify
 * @returns URL-friendly slug, or empty string if name has no alphanumeric chars
 *
 * @example
 * generateSlug("My Board Name") // => "my-board-name"
 * generateSlug("Auth & Security") // => "auth-security"
 * generateSlug("  Multiple   Spaces  ") // => "multiple-spaces"
 * generateSlug("🎉✨💫") // => "" (emoji-only, no alphanumeric chars)
 */
export function generateSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      // Replace non-alphanumeric chars with hyphens
      .replace(/[^a-z0-9]+/g, '-')
      // Remove consecutive hyphens
      .replace(/-+/g, '-')
      // Trim hyphens from start/end
      .replace(/^-|-$/g, '')
      // Limit length
      .slice(0, 64)
  );
}

/**
 * Generate a unique slug by appending a number suffix if needed.
 *
 * Returns empty string for names that contain no alphanumeric characters
 * (e.g., emoji-only names, CJK punctuation). The caller should handle this
 * by storing null in the database to avoid uniqueness constraint issues.
 *
 * @param baseName - The name to slugify
 * @param existingSlugs - Set or array of existing slugs to check against
 * @returns A unique slug (with -N suffix if needed), or empty string if no valid slug
 *
 * @example
 * generateUniqueSlug("My Board", ["my-board"]) // => "my-board-1"
 * generateUniqueSlug("My Board", ["my-board", "my-board-1"]) // => "my-board-2"
 * generateUniqueSlug("🎉✨", []) // => "" (no alphanumeric chars)
 */
export function generateUniqueSlug(
  baseName: string,
  existingSlugs: Set<string> | string[]
): string {
  const slugSet = existingSlugs instanceof Set ? existingSlugs : new Set(existingSlugs);
  const baseSlug = generateSlug(baseName);

  if (!baseSlug) {
    // Edge case: name produces empty slug (emoji-only, CJK punctuation, etc.)
    // Return empty string - caller should store null in DB
    return '';
  }

  if (!slugSet.has(baseSlug)) {
    return baseSlug;
  }

  // Find next available suffix
  let counter = 1;
  while (slugSet.has(`${baseSlug}-${counter}`)) {
    counter++;
  }

  return `${baseSlug}-${counter}`;
}

/**
 * Check if a string looks like a short ID (8+ hex characters).
 * Used to determine if URL param is a slug or short ID.
 *
 * @param value - String to check
 * @returns True if it looks like a short ID
 */
export function isShortId(value: string): boolean {
  return /^[0-9a-f]{8,}$/i.test(value);
}

/**
 * Determine if a string is a slug or ID for routing purposes.
 *
 * @param value - The URL parameter value
 * @returns 'slug' | 'short-id' | 'full-id'
 */
export function identifyUrlParam(value: string): 'slug' | 'short-id' | 'full-id' {
  // Full UUID (36 chars with hyphens)
  if (value.length === 36 && value.includes('-')) {
    return 'full-id';
  }

  // Short ID (8+ hex chars, no hyphens)
  if (/^[0-9a-f]{8,32}$/i.test(value)) {
    return 'short-id';
  }

  // Everything else is treated as a slug
  return 'slug';
}
