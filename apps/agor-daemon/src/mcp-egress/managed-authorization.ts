import { constants, type KeyObject, verify } from 'node:crypto';
import {
  MCP_OAUTH_JWS_TYPES,
  McpOAuthCapabilitiesSchema,
  McpOAuthJwsHeaderSchema,
  type McpOAuthOwner,
  McpOAuthSignedArtifactSchema,
  type McpOAuthUseClaims,
  McpOAuthUseClaimsSchema,
  mcpOAuthEgressAudience,
  mcpOAuthOwnerBytes,
  mcpOAuthParseJson,
  mcpOAuthSha256,
} from '@agor/core/types';
import type { ManagedAuthorityClock } from './managed-clock.js';

export class ManagedUseAuthorizationError extends Error {
  constructor(
    readonly code:
      | 'managed_authority_expired'
      | 'managed_authority_invalid'
      | 'managed_authority_unavailable'
  ) {
    super('Agor-managed sign-in authority is unavailable.');
    this.name = 'ManagedUseAuthorizationError';
  }
}

function decode(part: string): Buffer {
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part)
    throw new ManagedUseAuthorizationError('managed_authority_invalid');
  return bytes;
}

/**
 * No token/receipt retrieval, refresh or renewal is performed here. The saved
 * original claims are compared in full; loading a receipt again cannot extend
 * them. Call inside the caller's current local authority snapshot, immediately
 * before each physical socket (not just once at credential acquisition).
 */
export async function verifyManagedUseAuthorization(input: {
  signedAuthorization: string;
  authorization: string;
  /** Original co-issued claims persisted with this exact local grant. */
  expected: McpOAuthUseClaims;
  /** Trusted current local binding, never obtained from the signed token alone. */
  currentOwner: McpOAuthOwner;
  issuer: string;
  /** Current trusted worker keyring. No JKU, embedded JWK, or network key lookup. */
  keys: ReadonlyMap<string, KeyObject>;
  clock: ManagedAuthorityClock;
  /** Worker-authenticated snapshot; unknown/restarted capability state denies. */
  capabilities: unknown;
  wholeCellEligible: boolean;
  enforced: boolean;
  /** Must read durable locally known invalidation in the same authority unit. */
  assertNotInvalidated: (claims: McpOAuthUseClaims) => Promise<void>;
}): Promise<McpOAuthUseClaims> {
  let claims: McpOAuthUseClaims;
  try {
    const capabilities = McpOAuthCapabilitiesSchema.parse(input.capabilities);
    if (
      !input.enforced ||
      !input.wholeCellEligible ||
      !capabilities.available ||
      !capabilities.flags.managed_mcp_oauth_v1
    ) {
      throw new ManagedUseAuthorizationError('managed_authority_unavailable');
    }
    McpOAuthSignedArtifactSchema.parse(input.signedAuthorization);
    const [encodedHeader, encodedClaims, encodedSignature] = input.signedAuthorization.split(
      '.'
    ) as [string, string, string];
    const header = McpOAuthJwsHeaderSchema.parse(
      mcpOAuthParseJson(decode(encodedHeader).toString('utf8'), 1024)
    );
    const key = input.keys.get(header.kid);
    if (
      header.typ !== MCP_OAUTH_JWS_TYPES.use ||
      !key ||
      key.type !== 'public' ||
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      !verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key, padding: constants.RSA_PKCS1_PADDING },
        decode(encodedSignature)
      )
    ) {
      throw new ManagedUseAuthorizationError('managed_authority_invalid');
    }
    claims = McpOAuthUseClaimsSchema.parse(
      mcpOAuthParseJson(decode(encodedClaims).toString('utf8'), 24_576)
    );
    const expected = McpOAuthUseClaimsSchema.parse(input.expected);
    const bearer = /^Bearer ([^\s]+)$/.exec(input.authorization)?.[1];
    if (
      !bearer ||
      claims.token_digest !== mcpOAuthSha256(bearer) ||
      JSON.stringify(claims) !== JSON.stringify(expected) ||
      !Buffer.from(mcpOAuthOwnerBytes(claims.owner)).equals(
        Buffer.from(mcpOAuthOwnerBytes(input.currentOwner))
      ) ||
      claims.iss !== input.issuer ||
      claims.aud !== mcpOAuthEgressAudience(input.currentOwner) ||
      capabilities.recovery_incarnation !== claims.owner.recovery_incarnation ||
      capabilities.environment !== claims.owner.environment ||
      capabilities.residency_region !== claims.owner.residency_region ||
      !capabilities.profile_versions.some(
        (profile) =>
          profile.profile_id === claims.owner.profile_id &&
          profile.profile_version === claims.owner.profile_version &&
          profile.catalog_digest === claims.owner.catalog_digest
      )
    ) {
      throw new ManagedUseAuthorizationError('managed_authority_invalid');
    }
  } catch (error) {
    if (error instanceof ManagedUseAuthorizationError) throw error;
    throw new ManagedUseAuthorizationError('managed_authority_invalid');
  }
  const now = input.clock.latestUtcMs();
  if (now < claims.issued_at) throw new ManagedUseAuthorizationError('managed_authority_invalid');
  if (now >= claims.expires_at || now >= claims.token_expires_at)
    throw new ManagedUseAuthorizationError('managed_authority_expired');
  try {
    await input.assertNotInvalidated(claims);
  } catch {
    throw new ManagedUseAuthorizationError('managed_authority_unavailable');
  }
  // An awaited DB read must not carry a token past its absolute deadline.
  if (input.clock.latestUtcMs() >= claims.expires_at)
    throw new ManagedUseAuthorizationError('managed_authority_expired');
  return claims;
}
