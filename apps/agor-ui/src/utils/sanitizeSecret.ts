// Invisible/zero-width characters a paste can carry without anything showing
// up in the input: zero-width space (U+200B), ZWNJ (U+200C), ZWJ (U+200D),
// word joiner (U+2060), BOM (U+FEFF). Written as \u-escapes (never a literal
// invisible byte in source, which would be unreviewable) and as an
// alternation rather than a character class — a ZWJ in a char class trips
// biome's noMisleadingCharacterClass even when it's an escape, not a literal.
const ZERO_WIDTH_CHARS = /\u200b|\u200c|\u200d|\u2060|\ufeff/g;

/**
 * Sanitize a pasted secret (API key, OAuth/subscription token, bot token,
 * JWT secret, etc.) by stripping every whitespace character (not just
 * leading/trailing) and invisible/zero-width characters.
 *
 * Terminals soft-wrap long tokens (e.g. `claude setup-token` output) across
 * display lines. A copy-paste of the wrapped output can carry an embedded
 * newline or space at the wrap point that a plain `.trim()` won't catch,
 * silently corrupting the token. Rich-text sources (docs, chat apps, some
 * browsers) can likewise leave a zero-width character or a BOM in a paste
 * with nothing visibly different about it. These values never legitimately
 * contain whitespace or zero-width characters, so stripping both — anywhere
 * in the string — is safe.
 *
 * Do NOT use this for values where internal whitespace can be meaningful:
 * human account passwords, PEM-formatted keys (newlines are structural),
 * template expressions (e.g. `{{ user.env.VAR }}`), or generic env-var
 * values that aren't known to be opaque tokens.
 */
export function sanitizeSecretValue(value: string): string {
  return value.replace(ZERO_WIDTH_CHARS, '').replace(/\s+/g, '');
}
