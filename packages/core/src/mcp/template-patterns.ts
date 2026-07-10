/**
 * Browser-safe MCP template pattern helpers.
 *
 * Keep this module free of Handlebars, env resolution, and DB imports; UI
 * validation/redaction helpers import it through browser bundles.
 */

/**
 * Check if a string contains Handlebars template syntax.
 */
export function containsTemplate(value: string): boolean {
  return value.includes('{{') && value.includes('}}');
}

/**
 * Matches a value that is EXACTLY one bare `{{ user.env.NAME }}` placeholder:
 * optional surrounding/inner whitespace, a standard env-var name, nothing else.
 *
 * Deliberately rejects everything but a direct user-env reference: arbitrary
 * expressions, helper/fallback forms, partial values, and multiple expressions.
 */
const USER_ENV_PLACEHOLDER_RE = /^\{\{\s*user\.env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/;

/**
 * Check if a string is a single bare `{{ user.env.NAME }}` placeholder.
 */
export function isUserEnvPlaceholder(value: string): boolean {
  return USER_ENV_PLACEHOLDER_RE.test(value.trim());
}
