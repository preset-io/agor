/**
 * Redaction helpers for one-time launch authentication.
 *
 * Launch codes, returned assertions, the exchange bearer credential,
 * session cookies and database URLs must never reach daemon/UI errors, logs or
 * telemetry. These helpers scrub known secret shapes and any caller-supplied
 * literal secrets before a value is logged.
 */

const REDACTED = '[redacted]';

// `Authorization`/`Cookie` header values (`Header: value` or `Header=value`).
const HEADER_SECRET_RE =
  /\b(authorization|proxy-authorization|set-cookie|cookie)\b(\s*[:=]\s*)[^\n\r,;]+/gi;
// Bare `Bearer <token>` occurrences not attached to a header name.
const BEARER_RE = /\bBearer\s+[\w.\-+/=]+/gi;
// Credentialed database / connection URLs, e.g. postgres://user:pass@host/db.
const DB_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@\S+/gi;

/**
 * Scrub known secret shapes and any explicit secret literals from a string.
 * Explicit secrets are matched literally so per-request codes/assertions do not
 * leak even when they do not match a structural pattern.
 */
export function redactLaunchSecrets(
  input: string,
  secrets: Array<string | undefined> = []
): string {
  let output = input;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      output = output.split(secret).join(REDACTED);
    }
  }
  return output
    .replace(HEADER_SECRET_RE, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(DB_URL_RE, REDACTED);
}

/**
 * Build a secret-safe one-line operator diagnostic for a failed launch
 * exchange. Never includes the code, assertion, bearer credential or host
 * beyond a coarse reason label.
 */
export function safeLaunchDiagnostic(
  reason: string,
  secrets: Array<string | undefined> = []
): string {
  return `[auth/launch] ${redactLaunchSecrets(reason, secrets)}`;
}
