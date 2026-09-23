/**
 * Sealed browser-entry token for a Slack-delivered MCP connect link.
 *
 * Deliberately NOT a reuse of `mcp-slack-recovery-token.ts`. The two lanes
 * share a shape and almost nothing else:
 *
 *  - Different lifecycle. A recovery token is minted because a mediated MCP
 *    call already failed and is bound to that live Task's recovery state
 *    machine; a connect token is minted because a user asked for something and
 *    is bound to a pending `oauth` widget card.
 *  - Different binding set. A connect token pins `widget_id` — the landing
 *    page has to resolve exactly the card the user tapped — and pins the
 *    session owner and OAuth mode, none of which the recovery token carries.
 *
 * Sharing one type/audience would let a token issued for one lane satisfy the
 * other's verifier, which is the confused-deputy this separation removes. The
 * audience, envelope binding, and `type` discriminant are all distinct, so a
 * recovery token fails `isClaims` here and vice versa.
 *
 * Delivery is fragment-only (`#token=…`): the value never enters an HTTP path,
 * query string, or `Referer`. The SPA reads it from the fragment, clears it,
 * and POSTs it in a request body.
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.
 */

import { openBoundSecret, sealBoundSecret } from '@agor/core/db';
import type {
  MCPOAuthConnectTokenClaims,
  MCPSlackConnectDelivery,
  TenantID,
} from '@agor/core/types';

export const MCP_OAUTH_CONNECT_AUDIENCE = 'agor:mcp-oauth-connect' as const;
export const MCP_OAUTH_CONNECT_ISSUER = 'agor' as const;
const MCP_OAUTH_CONNECT_ENVELOPE_BINDING = 'agor:mcp-oauth-connect:v1';
const MCP_OAUTH_CONNECT_ENVELOPE_PURPOSE = 'slack-mcp-connect';

/**
 * Maximum lifetime, enforced at issue rather than left to each call site.
 *
 * A link posted into a Slack thread is visible to everyone in that thread for
 * as long as the thread exists. Ten minutes is short enough that the window in
 * which a stale scrollback entry is even worth tapping is small, and long
 * enough for a person to switch to a browser and sign in to Agor first.
 */
export const MCP_OAUTH_CONNECT_TOKEN_TTL_MS = 10 * 60 * 1_000;

function isBoundString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isClaims(value: unknown): value is MCPOAuthConnectTokenClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Partial<MCPOAuthConnectTokenClaims>;
  return (
    claims.type === 'mcp-oauth-connect' &&
    claims.aud === MCP_OAUTH_CONNECT_AUDIENCE &&
    claims.iss === MCP_OAUTH_CONNECT_ISSUER &&
    isBoundString(claims.tid) &&
    isBoundString(claims.sub) &&
    isBoundString(claims.credential_user_id) &&
    isBoundString(claims.slack_user_id) &&
    isBoundString(claims.slack_team_id) &&
    isBoundString(claims.gateway_channel_id) &&
    Number.isSafeInteger(claims.gateway_config_generation) &&
    claims.gateway_config_generation! >= 0 &&
    isBoundString(claims.slack_channel_id) &&
    isBoundString(claims.slack_thread_id, 2_048) &&
    isBoundString(claims.task_id) &&
    isBoundString(claims.session_id) &&
    isBoundString(claims.session_owner_user_id) &&
    isBoundString(claims.widget_id) &&
    isBoundString(claims.mcp_server_id) &&
    Number.isSafeInteger(claims.mcp_server_config_version) &&
    claims.mcp_server_config_version! >= 1 &&
    (claims.oauth_mode === 'per_user' || claims.oauth_mode === 'shared') &&
    isBoundString(claims.delivery_id) &&
    Number.isSafeInteger(claims.delivery_generation) &&
    claims.delivery_generation! >= 1 &&
    isBoundString(claims.jti) &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp)
  );
}

export function issueMCPOAuthConnectToken(
  input: Omit<MCPOAuthConnectTokenClaims, 'aud' | 'iss' | 'iat' | 'exp'> & {
    expiresAt: Date;
  },
  secret: string,
  now = new Date()
): string {
  const { expiresAt, ...claims } = input;
  const iat = Math.floor(now.getTime() / 1_000);
  const exp = Math.floor(expiresAt.getTime() / 1_000);
  if (!secret || exp <= iat) throw new Error('MCP OAuth connect token lifetime is invalid');
  // The ceiling belongs to the token type, not to whichever caller mints one.
  if ((exp - iat) * 1_000 > MCP_OAUTH_CONNECT_TOKEN_TTL_MS) {
    throw new Error('MCP OAuth connect token lifetime exceeds the permitted maximum');
  }
  return sealBoundSecret(
    JSON.stringify({
      ...claims,
      iat,
      exp,
      aud: MCP_OAUTH_CONNECT_AUDIENCE,
      iss: MCP_OAUTH_CONNECT_ISSUER,
    }),
    secret,
    MCP_OAUTH_CONNECT_ENVELOPE_PURPOSE,
    MCP_OAUTH_CONNECT_ENVELOPE_BINDING
  );
}

export function verifyMCPOAuthConnectToken(
  token: string,
  secret: string,
  now = new Date()
): MCPOAuthConnectTokenClaims {
  if (!isBoundString(token, 16_384)) throw new Error('MCP OAuth connect token is invalid');
  const decoded = JSON.parse(
    openBoundSecret(
      token,
      secret,
      MCP_OAUTH_CONNECT_ENVELOPE_PURPOSE,
      MCP_OAUTH_CONNECT_ENVELOPE_BINDING
    )
  ) as unknown;
  if (!isClaims(decoded)) throw new Error('MCP OAuth connect token binding is invalid');
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (decoded.exp <= nowSeconds || decoded.iat > nowSeconds + 30) {
    throw new Error('MCP OAuth connect token expired or is not yet valid');
  }
  if ((decoded.exp - decoded.iat) * 1_000 > MCP_OAUTH_CONNECT_TOKEN_TTL_MS) {
    throw new Error('MCP OAuth connect token lifetime exceeds the permitted maximum');
  }
  return decoded;
}

/**
 * Compare the token against the widget's durable delivery record.
 *
 * Only the fields the delivery record actually owns are compared here — the
 * one-use identity, the issue epoch, and the exact lifetime. Every other claim
 * (channel, thread, server, users, Slack sender) is checked against its own
 * authority by the redemption path, precisely so that no second copy of those
 * values can drift out of step with the row that governs them.
 */
export function mcpOAuthConnectClaimsMatchDelivery(
  claims: MCPOAuthConnectTokenClaims,
  delivery: MCPSlackConnectDelivery | undefined,
  tenantId: TenantID | string
): boolean {
  return (
    !!delivery &&
    claims.tid === tenantId &&
    claims.delivery_id === delivery.delivery_id &&
    claims.delivery_generation === delivery.delivery_generation &&
    claims.jti === delivery.token_jti &&
    claims.iat * 1_000 === new Date(delivery.issued_at).getTime() &&
    claims.exp * 1_000 === new Date(delivery.expires_at).getTime()
  );
}

/**
 * The redeemer must BE the person the link was issued for — signed into Agor
 * as both the principal and the credential owner. This is the no-delegation
 * rule: a link that arrived in a shared Slack thread authenticates nobody.
 */
export function mcpOAuthConnectClaimsMatchCaller(
  claims: MCPOAuthConnectTokenClaims,
  tenantId: string | undefined,
  userId: string | undefined
): boolean {
  return (
    !!tenantId &&
    !!userId &&
    claims.tid === tenantId &&
    claims.sub === userId &&
    claims.credential_user_id === userId
  );
}
