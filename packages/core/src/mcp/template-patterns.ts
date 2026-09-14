/**
 * Browser-safe MCP template pattern helpers.
 *
 * Keep this module free of Handlebars, env resolution, and DB imports; UI
 * validation/redaction helpers import it through browser bundles.
 */

/**
 * Check whether a value contains a balanced-looking Handlebars expression.
 * This does not prove the expression is renderable; use `hasTemplateMarker`
 * at security/admission boundaries so unmatched delimiters cannot pass as
 * harmless literals.
 */
export function containsTemplate(value: string): boolean {
  return value.includes('{{') && value.includes('}}');
}

/** Any opening OR closing Handlebars delimiter, balanced or otherwise. */
export function hasTemplateMarker(value: string | undefined): boolean {
  return typeof value === 'string' && (value.includes('{{') || value.includes('}}'));
}

/**
 * Matches a value that is EXACTLY one bare `{{ user.env.NAME }}` placeholder:
 * optional surrounding/inner whitespace, a standard env-var name, nothing else.
 *
 * Deliberately rejects everything but a direct user-env reference: arbitrary
 * expressions, helper/fallback forms, partial values, and multiple expressions.
 */
const USER_ENV_PLACEHOLDER_RE = /^\{\{\s*user\.env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/;
const USER_ENV_REFERENCE_RE = /\{\{\s*user\.env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g;

/**
 * Check if a string is a single bare `{{ user.env.NAME }}` placeholder.
 */
export function isUserEnvPlaceholder(value: string): boolean {
  return USER_ENV_PLACEHOLDER_RE.test(value.trim());
}

/**
 * Validate a persisted HTTP(S) URL template without resolving user secrets.
 * Only direct `user.env` references are admitted. Runtime resolution still
 * validates the final URL before egress; this check closes the stored shape.
 */
export function isValidMCPHttpUrlTemplate(value: string): boolean {
  if (!hasTemplateMarker(value)) return false;
  const substituted = value.replace(USER_ENV_REFERENCE_RE, 'template-value');
  if (hasTemplateMarker(substituted)) return false;
  const candidate = substituted.startsWith('template-value')
    ? `https://template.invalid${substituted.slice('template-value'.length)}`
    : substituted;
  try {
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
