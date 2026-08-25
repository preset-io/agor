/**
 * Provider-neutral, bounded error text for connector/service boundaries.
 * Provider SDK errors are not safe to pass through: some include bearer
 * credentials, token-shaped values, URLs, paths, or control characters.
 */
export function sanitizeGatewayProviderError(error: unknown, maxLength = 240): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutControls = Array.from(raw, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('');
  const sanitized = withoutControls
    .replace(/(xox[baprs]-)[A-Za-z0-9-]+/gi, '$1[redacted]')
    .replace(/Bot\s+[A-Za-z0-9._~-]{20,}/gi, 'Bot [redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    // Discord tokens can appear without an authorization prefix. Require
    // realistic segment lengths and token boundaries so dotted diagnostics do
    // not get mistaken for credentials.
    .replace(
      /(?<![A-Za-z0-9._-])[A-Za-z0-9_-]{20,32}\.[A-Za-z0-9_-]{5,12}\.[A-Za-z0-9_-]{20,40}(?![A-Za-z0-9._-])/g,
      '[redacted-discord-token]'
    )
    .replace(/(?:token|secret|password|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[provider-url]')
    .replace(/(?:^|\s)(?:[A-Za-z]:)?(?:\/[^\s]+){2,}/g, ' [path]')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || 'Provider request failed').slice(0, maxLength);
}

/** Stable, content-free category for operational logs and terminal notices. */
export function gatewayFailureCode(error: unknown): string {
  const record =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  const status = record?.status ?? record?.statusCode;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'provider_auth_failed';
    if (status === 404) return 'provider_not_found';
    if (status === 429) return 'provider_rate_limited';
    if (status >= 400 && status < 500) return 'provider_client_error';
    if (status >= 500 && status < 600) return 'provider_server_error';
  }

  const kind = record?.kind;
  if (
    kind === 'unsupported' ||
    kind === 'incomplete' ||
    kind === 'malformed' ||
    kind === 'prompt_limit'
  ) {
    return `provider_history_${kind}`;
  }
  return 'provider_request_failed';
}
