/**
 * Sanitize a pasted secret (API key, OAuth/subscription token, bot token,
 * JWT secret, etc.) by stripping every whitespace character, not just
 * leading/trailing.
 *
 * Terminals soft-wrap long tokens (e.g. `claude setup-token` output) across
 * display lines. A copy-paste of the wrapped output can carry an embedded
 * newline or space at the wrap point that a plain `.trim()` won't catch,
 * silently corrupting the token. These values never legitimately contain
 * whitespace, so stripping it entirely — anywhere in the string — is safe.
 *
 * Do NOT use this for values where internal whitespace can be meaningful:
 * human account passwords, PEM-formatted keys (newlines are structural),
 * template expressions (e.g. `{{ user.env.VAR }}`), or generic env-var
 * values that aren't known to be opaque tokens.
 */
export function sanitizeSecretValue(value: string): string {
  return value.replace(/\s+/g, '');
}
