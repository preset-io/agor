/**
 * Token-endpoint client authentication (RFC 6749 §2.3.1, RFC 8414 §2).
 *
 * Both the authorization-code exchange and the refresh grant authenticate the
 * client at the SAME token endpoint, so they must use the SAME method. This
 * module is the single place that decides which one, so the two callsites
 * cannot drift.
 *
 * Why this exists: Agor previously hard-coded HTTP Basic whenever a client
 * secret was present. Authorization servers are permitted to support only
 * `client_secret_post` — HubSpot's MCP authorization server advertises
 * exactly `token_endpoint_auth_methods_supported: ["client_secret_post"]` —
 * and reject Basic with `invalid_client`. Honouring the advertised method
 * fixes those providers without changing anything for Basic-capable ones.
 */

/** The client-authentication methods Agor can actually perform. */
export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

export function isTokenEndpointAuthMethod(value: unknown): value is TokenEndpointAuthMethod {
  return value === 'client_secret_basic' || value === 'client_secret_post' || value === 'none';
}

/**
 * Choose the token-endpoint client authentication method for a grant.
 *
 * Rules, in order:
 *
 *  1. No client secret → `none`. A public client can only send `client_id` in
 *     the request body (RFC 6749 §3.2.1). This is unchanged behaviour and
 *     covers every DCR-registered client, which Agor registers with
 *     `token_endpoint_auth_method: 'none'`.
 *  2. A registered per-client method (RFC 7591 §2 `token_endpoint_auth_method`
 *     returned by Dynamic Client Registration) is authoritative for THAT
 *     client and wins over the server-wide list.
 *  3. Metadata absent or empty → `client_secret_basic`. RFC 8414 §2 states
 *     that when `token_endpoint_auth_methods_supported` is omitted, "the
 *     default is `client_secret_basic`". This is also Agor's historical
 *     behaviour, so Slack / Figma / GitHub and every manually configured
 *     confidential client keep working byte-for-byte.
 *  4. Metadata lists `client_secret_basic` → `client_secret_basic`. RFC 6749
 *     §2.3.1 says servers MUST support Basic and clients SHOULD prefer it, so
 *     Basic stays the preferred method whenever it is on offer.
 *  5. Otherwise metadata lists `client_secret_post` → `client_secret_post`.
 *     This is the HubSpot case.
 *  6. Otherwise the server advertises only methods Agor cannot perform
 *     (`private_key_jwt`, `tls_client_auth`, …). If `none` is among them the
 *     server accepts unauthenticated clients, so use it and withhold the
 *     secret. Otherwise fall back to the RFC 8414 default rather than failing
 *     the flow outright — a wrong guess surfaces as a normal provider
 *     rejection, whereas a hard failure would break servers whose metadata is
 *     merely incomplete.
 */
export function selectTokenEndpointAuthMethod(opts: {
  hasClientSecret: boolean;
  /** `token_endpoint_auth_methods_supported` from RFC 8414 metadata, if any. */
  supportedMethods?: readonly string[] | null;
  /** `token_endpoint_auth_method` returned by RFC 7591 registration, if any. */
  registeredMethod?: string | null;
}): TokenEndpointAuthMethod {
  if (!opts.hasClientSecret) return 'none';

  if (isTokenEndpointAuthMethod(opts.registeredMethod) && opts.registeredMethod !== 'none') {
    return opts.registeredMethod;
  }

  const supported = opts.supportedMethods?.filter((m) => typeof m === 'string') ?? [];
  if (supported.length === 0) return 'client_secret_basic';
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  if (supported.includes('none')) return 'none';
  return 'client_secret_basic';
}

/**
 * Apply the selected method to an outgoing token request.
 *
 * Mutates `headers` / `body` in place. Exactly one method is applied: RFC 6749
 * §2.3 forbids a client from using more than one authentication method per
 * request, so a server that sees both a Basic header and body credentials may
 * reject the request.
 */
export function applyClientAuthentication(opts: {
  method: TokenEndpointAuthMethod;
  clientId: string;
  clientSecret?: string;
  headers: Record<string, string>;
  body: Record<string, string>;
}): void {
  const { method, clientId, clientSecret, headers, body } = opts;

  if (method === 'client_secret_basic' && clientSecret) {
    // Encoding is deliberately left as a raw `id:secret` concatenation to
    // match what Agor has always sent. Re-encoding here would change the
    // credential seen by every provider that works today.
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    return;
  }

  // `client_secret_post` (RFC 6749 §2.3.1) and the public-client case
  // (§3.2.1) both identify the client in the form body; only the former
  // carries the secret.
  body.client_id = clientId;
  if (method === 'client_secret_post' && clientSecret) {
    body.client_secret = clientSecret;
  }
}
