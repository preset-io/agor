/**
 * URL normalization utilities
 *
 * Provides shared helpers for validating and normalizing user-provided URLs.
 */

/**
 * Normalize an optional HTTP(S) URL string.
 *
 * - Trims whitespace
 * - Returns `undefined` for empty or missing values
 * - Validates that protocol is http or https
 * - Returns canonical `.toString()` representation
 *
 * @param value - Potential URL value from user input
 * @param fieldName - Friendly field name for error messages
 * @throws Error if the URL is present but invalid or not http(s)
 */
export function normalizeOptionalHttpUrl(value: unknown, fieldName = 'value'): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${fieldName} must use http or https`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(fieldName)) {
      throw error;
    }
    throw new Error(`${fieldName} must be a valid http(s) URL`);
  }
}
