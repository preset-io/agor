import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

/** Canonical D0. Changing security semantics requires a paired runtime fixture update. */
export const MCP_OAUTH_PROTOCOL_VERSION = 1 as const;
export const MCP_OAUTH_BINDING_VERSION = 1 as const;
export const MCP_OAUTH_ENFORCEMENT_VERSION = 1 as const;
export const MCP_OAUTH_LIMITS = Object.freeze({
  request_bytes: 65_536,
  response_bytes: 131_072,
  token_bytes: 16_384,
  attempt_ms: 600_000,
  intent_ms: 120_000,
  ticket_ms: 60_000,
  claim_ms: 120_000,
  dispatch_headroom_ms: 45_000,
  provider_timeout_ms: 30_000,
  cell_timeout_ms: 45_000,
  recovery_timeout_ms: 10_000,
  receipt_ms: 600_000,
  use_ms: 3_595_000,
  use_clock_allowance_ms: 5_000,
  sender_lifetime_seconds: 60,
  sender_skew_seconds: 30,
  replay_ms: 150_000,
  cleanup_ms: 86_400_000,
  invalidation_page: 100,
  poll_ms: 30_000,
  jitter_ms: 5_000,
});
export const McpOAuthIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** Legacy fixture IDs or reverse-DNS namespace / slug; no URL, escaping or path traversal.
 * Syntax is not admission: prepare must still match the exact reviewed Catalog name.
 */
export const McpOAuthCatalogEntryNameSchema = z
  .string()
  .max(253)
  .refine((value) => {
    if (/^[A-Za-z0-9_-]{1,128}$/.test(value)) return true;
    const parts = value.split('/');
    if (parts.length !== 2) return false;
    const labels = parts[0].split('.');
    return (
      labels.length >= 2 &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
      /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/.test(parts[1])
    );
  }, 'Expected exact reviewed Catalog name');
export const McpOAuthDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const McpOAuthOpaqueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const McpOAuthEpochSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
    'Epoch overflow'
  );
export const McpOAuthPositiveEpochSchema = McpOAuthEpochSchema.refine((value) => value !== '0');
export const McpOAuthTimeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const McpOAuthEnvironmentSchema = z.enum(['staging', 'production']);
export const McpOAuthRegionSchema = z.literal('us-west-2');
export const McpOAuthHttpsUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.hash &&
        (!url.port || url.port === '443') &&
        url.href === value &&
        !url.hostname.endsWith('.') &&
        !value.includes('\\') &&
        !/%(?:2f|5c|00)/i.test(value)
      );
    } catch {
      return false;
    }
  }, 'Expected exact canonical HTTPS URL');
export const McpOAuthOriginSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return (
        new URL(value).origin === value && McpOAuthHttpsUrlSchema.safeParse(`${value}/`).success
      );
    } catch {
      return false;
    }
  }, 'Expected canonical HTTPS origin');

/** cloud_user_subject is the stable Cloud users.id, never an email or cell assertion of identity. */
export const McpOAuthOwnerSchema = z.strictObject({
  environment: McpOAuthEnvironmentSchema,
  residency_region: McpOAuthRegionSchema,
  recovery_incarnation: McpOAuthOpaqueSchema,
  workspace_id: McpOAuthIdSchema,
  cloud_user_subject: McpOAuthIdSchema,
  cell_local_user_id: McpOAuthIdSchema,
  server_id: McpOAuthIdSchema,
  attempt_id: McpOAuthIdSchema,
  profile_id: McpOAuthIdSchema,
  profile_version: McpOAuthPositiveEpochSchema,
  catalog_digest: McpOAuthDigestSchema,
  config_fingerprint: McpOAuthDigestSchema,
  grant_generation: McpOAuthEpochSchema,
  membership_id: McpOAuthIdSchema,
  cell_id: McpOAuthIdSchema,
  data_plane_id: McpOAuthIdSchema,
  placement_epoch: McpOAuthPositiveEpochSchema,
  identity_epoch: McpOAuthPositiveEpochSchema,
  user_identity_epoch: McpOAuthPositiveEpochSchema,
  cell_authority_epoch: McpOAuthPositiveEpochSchema,
  data_plane_authority_epoch: McpOAuthPositiveEpochSchema,
});
export type McpOAuthOwner = z.infer<typeof McpOAuthOwnerSchema>;
export const MCP_OAUTH_OWNER_FIELDS = Object.keys(
  McpOAuthOwnerSchema.shape
) as (keyof McpOAuthOwner)[];
export const McpOAuthClaimSchema = z
  .strictObject({
    kind: z.enum(['exchange', 'refresh']),
    claim_id: McpOAuthIdSchema,
    claimed_at: McpOAuthTimeSchema,
    deadline_at: McpOAuthTimeSchema,
    refresh_generation: McpOAuthEpochSchema,
    refresh_success_generation: McpOAuthEpochSchema,
  })
  .refine(
    (claim) => claim.deadline_at - claim.claimed_at === MCP_OAUTH_LIMITS.claim_ms,
    'The original claim deadline must not be extended'
  );
export type McpOAuthClaim = z.infer<typeof McpOAuthClaimSchema>;
const baseRequest = {
  protocol_version: z.literal(1),
  operation_id: McpOAuthIdSchema,
  owner: McpOAuthOwnerSchema,
};
export const McpOAuthPrepareRequestSchema = z.strictObject({
  ...baseRequest,
  catalog_entry_name: McpOAuthCatalogEntryNameSchema,
  pkce_challenge: McpOAuthOpaqueSchema,
  method: z.literal('S256'),
  client_nonce_hash: McpOAuthDigestSchema,
  replacement_handle: McpOAuthOpaqueSchema.nullable(),
});
export const McpOAuthTransactionRequestSchema = z.strictObject({
  ...baseRequest,
  transaction_id: McpOAuthIdSchema,
});
export const McpOAuthExchangeRequestSchema = z
  .strictObject({
    ...baseRequest,
    transaction_id: McpOAuthIdSchema,
    claim: McpOAuthClaimSchema,
    cancel_epoch: McpOAuthEpochSchema,
    pkce_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  })
  .refine((value) => value.claim.kind === 'exchange');
export const McpOAuthRefreshRequestSchema = z
  .strictObject({
    ...baseRequest,
    handle: McpOAuthOpaqueSchema,
    handle_epoch: McpOAuthPositiveEpochSchema,
    sequence: McpOAuthEpochSchema,
    claim: McpOAuthClaimSchema,
    refresh_token: z.string().min(1).max(MCP_OAUTH_LIMITS.token_bytes),
  })
  .refine((value) => value.claim.kind === 'refresh');
export const McpOAuthCancelRequestSchema = z.strictObject({
  ...baseRequest,
  transaction_id: McpOAuthIdSchema,
  expected_cancel_epoch: McpOAuthEpochSchema,
});
/** Inhibits only the saved prepare owner/operation; never proof that dispatch did not occur. */
export const McpOAuthCancelReservationRequestSchema = z.strictObject({
  ...baseRequest,
  prepare_operation_id: McpOAuthIdSchema,
});
export const McpOAuthCancelReservationResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  canceled: z.literal(true),
  prepare_operation_id: McpOAuthIdSchema,
});
/** Operator-reviewed, signed-worker-config capability. Never supplied by runtime requests.
 * Only non-vending cancel-reservation, close and cleanup may use this historical cell scope.
 */
export const McpOAuthCleanupAuthoritySchema = z
  .strictObject({
    environment: McpOAuthEnvironmentSchema,
    residency_region: McpOAuthRegionSchema,
    recovery_incarnation: McpOAuthOpaqueSchema,
    cell_id: McpOAuthIdSchema,
    cell_authority_epoch: McpOAuthPositiveEpochSchema,
    data_plane_id: McpOAuthIdSchema,
    data_plane_authority_epoch: McpOAuthPositiveEpochSchema,
    issued_at: McpOAuthTimeSchema,
    expires_at: McpOAuthTimeSchema,
    approval_reference: McpOAuthIdSchema,
  })
  .refine(
    (v) => v.expires_at > v.issued_at && v.expires_at - v.issued_at <= MCP_OAUTH_LIMITS.cleanup_ms,
    'Historical cleanup capability exceeds its bounded lifetime'
  );
export type McpOAuthCleanupAuthority = z.infer<typeof McpOAuthCleanupAuthoritySchema>;
export const McpOAuthReceiptRequestSchema = z.strictObject({
  ...baseRequest,
  target_operation_id: McpOAuthIdSchema,
  claim: McpOAuthClaimSchema,
});
export const McpOAuthAckRequestSchema = z.strictObject({
  ...baseRequest,
  target_operation_id: McpOAuthIdSchema,
  receipt_id: McpOAuthIdSchema,
  claim: McpOAuthClaimSchema,
  cell_commit_fence: McpOAuthDigestSchema,
});
export const McpOAuthCloseReasonSchema = z.enum([
  'user_disconnect',
  'attempt_canceled',
  'subject_removed',
  'configuration_changed',
  'workspace_deleted',
  'workspace_rehome',
  'security_disabled',
  'recovery_retired',
]);
export const McpOAuthCloseRequestSchema = z.strictObject({
  ...baseRequest,
  handle: McpOAuthOpaqueSchema,
  expected_epoch: McpOAuthPositiveEpochSchema,
  reason: McpOAuthCloseReasonSchema,
});
export const McpOAuthCleanupRequestSchema = z.strictObject({
  ...baseRequest,
  handle: McpOAuthOpaqueSchema,
  expected_epoch: McpOAuthPositiveEpochSchema,
  cleanup_authorization_id: McpOAuthIdSchema,
  token: z.string().min(1).max(MCP_OAUTH_LIMITS.token_bytes),
  token_type_hint: z.enum(['access_token', 'refresh_token']),
});
export const McpOAuthReturnTicketRequestSchema = z.strictObject({
  ...baseRequest,
  ticket: McpOAuthOpaqueSchema,
  client_nonce_hash: McpOAuthDigestSchema,
  request_origin: McpOAuthOriginSchema,
});
export const McpOAuthTokensSchema = z.strictObject({
  access_token: z.string().min(1).max(MCP_OAUTH_LIMITS.token_bytes),
  refresh_token: z.string().min(1).max(MCP_OAUTH_LIMITS.token_bytes),
  token_type: z.literal('Bearer'),
  expires_at: McpOAuthTimeSchema,
  scope: z.string().max(4096).nullable(),
});
export type McpOAuthTokens = z.infer<typeof McpOAuthTokensSchema>;
const signedBinding = {
  protocol_version: z.literal(1),
  binding_version: z.literal(1),
  enforcement_version: z.literal(1),
  iss: McpOAuthHttpsUrlSchema,
  aud: z.string().min(1).max(512),
  owner: McpOAuthOwnerSchema,
  claim: McpOAuthClaimSchema,
  operation_id: McpOAuthIdSchema,
  receipt_id: McpOAuthIdSchema,
  handle: McpOAuthOpaqueSchema,
  handle_epoch: McpOAuthPositiveEpochSchema,
  sequence: McpOAuthEpochSchema,
  next_sequence: McpOAuthPositiveEpochSchema,
  token_digest: McpOAuthDigestSchema,
  issued_at: McpOAuthTimeSchema,
  expires_at: McpOAuthTimeSchema,
};
function nextSequence(value: { sequence: string; next_sequence: string }) {
  return (
    McpOAuthEpochSchema.safeParse(value.sequence).success &&
    McpOAuthEpochSchema.safeParse(value.next_sequence).success &&
    BigInt(value.next_sequence) === BigInt(value.sequence) + 1n
  );
}
export const McpOAuthUseClaimsSchema = z
  .strictObject({
    ...signedBinding,
    kind: z.literal('mcp_oauth_use'),
    token_expires_at: McpOAuthTimeSchema,
  })
  .refine(nextSequence, 'Invalid sequence progression')
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at ===
        Math.min(value.token_expires_at, value.issued_at + MCP_OAUTH_LIMITS.use_ms),
    'Invalid fixed use deadline'
  );
export const McpOAuthReceiptClaimsSchema = z
  .strictObject({
    ...signedBinding,
    kind: z.literal('mcp_oauth_receipt'),
    tokens_digest: McpOAuthDigestSchema,
    use_authorization_digest: McpOAuthDigestSchema,
  })
  .refine(nextSequence, 'Invalid sequence progression')
  .refine(
    (value) => value.expires_at === value.issued_at + MCP_OAUTH_LIMITS.receipt_ms,
    'Invalid receipt deadline'
  );
export type McpOAuthUseClaims = z.infer<typeof McpOAuthUseClaimsSchema>;
export type McpOAuthReceiptClaims = z.infer<typeof McpOAuthReceiptClaimsSchema>;
export const McpOAuthSignedArtifactSchema = z
  .string()
  .max(32_768)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const MCP_OAUTH_JWS_TYPES = Object.freeze({
  sender: 'mcp-oauth-sender+jwt',
  receipt: 'mcp-oauth-receipt+jwt',
  use: 'mcp-oauth-use+jwt',
});
export const McpOAuthJwsHeaderSchema = z.strictObject({
  alg: z.literal('RS256'),
  kid: McpOAuthIdSchema,
  typ: z.enum([MCP_OAUTH_JWS_TYPES.sender, MCP_OAUTH_JWS_TYPES.receipt, MCP_OAUTH_JWS_TYPES.use]),
});
const outcomeBase = {
  protocol_version: z.literal(1),
  operation_id: McpOAuthIdSchema,
  owner: McpOAuthOwnerSchema,
  claim: McpOAuthClaimSchema,
};
export const McpOAuthSucceededSchema = z.strictObject({
  ...outcomeBase,
  status: z.literal('succeeded'),
  receipt_id: McpOAuthIdSchema,
  handle: McpOAuthOpaqueSchema,
  handle_epoch: McpOAuthPositiveEpochSchema,
  sequence: McpOAuthEpochSchema,
  next_sequence: McpOAuthPositiveEpochSchema,
  issued_at: McpOAuthTimeSchema,
  expires_at: McpOAuthTimeSchema,
  tokens: McpOAuthTokensSchema,
  signed_receipt: McpOAuthSignedArtifactSchema,
  use_authorization: McpOAuthSignedArtifactSchema,
});
export const McpOAuthFailureCodeSchema = z.enum([
  'capacity_unavailable',
  'authority_unavailable',
  'authority_denied',
  'claim_expired',
  'operation_in_progress',
  'provider_grant_invalid',
  'client_configuration_failed',
  'provider_rate_limited',
  'provider_rejected',
  'provider_outcome_ambiguous',
  'refresh_rotation_policy_violation',
  'operation_canceled',
  'receipt_expired',
  'receipt_acknowledged',
  'stale_fence',
  'recovery_denied',
  'profile_unavailable',
  'callback_failed',
]);
export const McpOAuthOperationResponseSchema = z
  .discriminatedUnion('status', [
    McpOAuthSucceededSchema,
    z.strictObject({
      ...outcomeBase,
      status: z.literal('not_dispatched'),
      failure_code: McpOAuthFailureCodeSchema,
      sequence: McpOAuthEpochSchema,
    }),
    z.strictObject({
      ...outcomeBase,
      status: z.literal('in_progress'),
      failure_code: z.literal('operation_in_progress'),
      sequence: McpOAuthEpochSchema,
    }),
    z.strictObject({
      ...outcomeBase,
      status: z.literal('grant_invalid'),
      failure_code: z.literal('provider_grant_invalid'),
      sequence: McpOAuthEpochSchema,
    }),
    z.strictObject({
      ...outcomeBase,
      status: z.literal('client_configuration_failed'),
      failure_code: z.literal('client_configuration_failed'),
      sequence: McpOAuthEpochSchema,
      next_sequence: McpOAuthPositiveEpochSchema,
    }),
    z.strictObject({
      ...outcomeBase,
      status: z.literal('rejected_non_consuming'),
      failure_code: McpOAuthFailureCodeSchema,
      sequence: McpOAuthEpochSchema,
      next_sequence: McpOAuthPositiveEpochSchema,
      retry_after_ms: z.number().int().min(0).max(300_000),
    }),
    z.strictObject({
      ...outcomeBase,
      status: z.literal('ambiguous'),
      failure_code: McpOAuthFailureCodeSchema,
      sequence: McpOAuthEpochSchema,
    }),
    z.strictObject({
      ...outcomeBase,
      status: z.literal('canceled'),
      failure_code: z.literal('operation_canceled'),
      sequence: McpOAuthEpochSchema,
    }),
    z.strictObject({
      ...outcomeBase,
      status: z.literal('expired'),
      failure_code: z.literal('receipt_expired'),
      sequence: McpOAuthEpochSchema,
    }),
    z.strictObject({
      ...outcomeBase,
      status: z.literal('acknowledged'),
      failure_code: z.literal('receipt_acknowledged'),
      sequence: McpOAuthEpochSchema,
    }),
  ])
  .refine(
    (value) => !('next_sequence' in value) || nextSequence(value),
    'Invalid sequence progression'
  );
export type McpOAuthOperationResponse = z.infer<typeof McpOAuthOperationResponseSchema>;
export type McpOAuthPrepareRequest = z.infer<typeof McpOAuthPrepareRequestSchema>;
export type McpOAuthExchangeRequest = z.infer<typeof McpOAuthExchangeRequestSchema>;
export type McpOAuthRefreshRequest = z.infer<typeof McpOAuthRefreshRequestSchema>;
export type McpOAuthAckRequest = z.infer<typeof McpOAuthAckRequestSchema>;
export type McpOAuthCloseRequest = z.infer<typeof McpOAuthCloseRequestSchema>;

export const MCP_OAUTH_INTERNAL_BASE = '/api/internal/mcp-oauth/v1';
export const MCP_OAUTH_CONSOLE_BASE = '/api/mcp-oauth/v1';
export const MCP_OAUTH_ROUTES = Object.freeze({
  capabilities: `${MCP_OAUTH_INTERNAL_BASE}/capabilities`,
  authority: `${MCP_OAUTH_INTERNAL_BASE}/authority`,
  prepare: `${MCP_OAUTH_INTERNAL_BASE}/transactions`,
  activate: `${MCP_OAUTH_INTERNAL_BASE}/transactions/:id/activate-intent`,
  status: `${MCP_OAUTH_INTERNAL_BASE}/transactions/:id/status`,
  exchange: `${MCP_OAUTH_INTERNAL_BASE}/transactions/:id/exchange`,
  cancel: `${MCP_OAUTH_INTERNAL_BASE}/transactions/:id/cancel`,
  cancel_reservation: `${MCP_OAUTH_INTERNAL_BASE}/reservations/:id/cancel`,
  refresh: `${MCP_OAUTH_INTERNAL_BASE}/grants/:id/refresh`,
  close: `${MCP_OAUTH_INTERNAL_BASE}/grants/:id/close`,
  cleanup: `${MCP_OAUTH_INTERNAL_BASE}/grants/:id/cleanup`,
  receipt: `${MCP_OAUTH_INTERNAL_BASE}/operations/:id/receipt`,
  ack: `${MCP_OAUTH_INTERNAL_BASE}/operations/:id/ack`,
  invalidations: `${MCP_OAUTH_INTERNAL_BASE}/invalidations`,
  return_ticket: `${MCP_OAUTH_INTERNAL_BASE}/return-tickets/consume`,
  bootstrap: '/v1/authorize/bootstrap',
  callback: '/v1/callback/:key',
  browser_capabilities: `${MCP_OAUTH_CONSOLE_BASE}/capabilities`,
  continue: `${MCP_OAUTH_CONSOLE_BASE}/intents/continue`,
  finalize: `${MCP_OAUTH_CONSOLE_BASE}/transactions/:id/finalize-browser`,
  browser_revoke: `${MCP_OAUTH_CONSOLE_BASE}/grants/:id/revoke`,
});
export const McpOAuthScopeSchema = z.enum([
  'mcp_oauth:authority',
  'mcp_oauth:prepare',
  'mcp_oauth:activate',
  'mcp_oauth:status',
  'mcp_oauth:exchange',
  'mcp_oauth:refresh',
  'mcp_oauth:receipt',
  'mcp_oauth:ack',
  'mcp_oauth:cancel',
  'mcp_oauth:cancel_reservation',
  'mcp_oauth:close',
  'mcp_oauth:cleanup',
  'mcp_oauth:capabilities',
  'mcp_oauth:invalidations',
  'mcp_oauth:return_ticket',
]);
export const McpOAuthSenderClaimsSchema = z
  .strictObject({
    iss: McpOAuthIdSchema,
    sub: McpOAuthIdSchema,
    aud: z.string().min(1).max(256),
    iat: McpOAuthTimeSchema,
    exp: McpOAuthTimeSchema,
    jti: McpOAuthIdSchema,
    credential_id: McpOAuthIdSchema,
    cell_id: McpOAuthIdSchema,
    environment: McpOAuthEnvironmentSchema,
    residency_region: McpOAuthRegionSchema,
    scope: McpOAuthScopeSchema,
    http_method: z.literal('POST'),
    target_uri: McpOAuthHttpsUrlSchema,
    body_sha256: McpOAuthDigestSchema,
    operation_id: McpOAuthIdSchema,
  })
  .refine(
    (value) =>
      value.exp > value.iat &&
      value.exp - value.iat <= 60 &&
      value.sub === value.cell_id &&
      value.iss === value.cell_id,
    'Invalid sender lifetime or identity'
  );
export type McpOAuthSenderClaims = z.infer<typeof McpOAuthSenderClaimsSchema>;
export function mcpOAuthSenderAudience(
  environment: McpOAuthOwner['environment'],
  region: McpOAuthOwner['residency_region']
) {
  return `agor-cloud:mcp-oauth:v1:${environment}:${region}`;
}
export function mcpOAuthEgressAudience(owner: McpOAuthOwner) {
  return `agor:mcp-egress:v1:${owner.environment}:${owner.residency_region}:${owner.cell_id}`;
}
export function mcpOAuthReceiptAudience(owner: McpOAuthOwner) {
  return `agor:mcp-oauth-receipt:v1:${owner.environment}:${owner.residency_region}:${owner.cell_id}`;
}
/** U32BE byte lengths; no concatenation ambiguity, normalization, locale or delimiter rules. */
export function mcpOAuthLengthPrefix(parts: readonly string[]): Uint8Array {
  const encoded = parts.map(utf8ToBytes);
  const output = new Uint8Array(encoded.reduce((sum, value) => sum + 4 + value.length, 0));
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
export function mcpOAuthSha256(value: string | Uint8Array): string {
  return bytesToHex(sha256(typeof value === 'string' ? utf8ToBytes(value) : value));
}
export function mcpOAuthOwnerBytes(owner: McpOAuthOwner): Uint8Array {
  const parsed = McpOAuthOwnerSchema.parse(owner);
  return mcpOAuthLengthPrefix([
    'agor-mcp-oauth-owner-v1',
    ...MCP_OAUTH_OWNER_FIELDS.flatMap((key) => [key, parsed[key]]),
  ]);
}
export function mcpOAuthTokensDigest(tokens: McpOAuthTokens): string {
  const parsed = McpOAuthTokensSchema.parse(tokens);
  return mcpOAuthSha256(
    mcpOAuthLengthPrefix([
      'agor-mcp-oauth-tokens-v1',
      parsed.access_token,
      parsed.refresh_token,
      parsed.token_type,
      String(parsed.expires_at),
      parsed.scope === null ? 'null' : `scope:${parsed.scope}`,
    ])
  );
}
export function mcpOAuthClaimIsLive(
  claim: McpOAuthClaim,
  now: number,
  forDispatch = false
): boolean {
  return (
    McpOAuthClaimSchema.safeParse(claim).success &&
    Number.isSafeInteger(now) &&
    now >= claim.claimed_at &&
    now < claim.deadline_at &&
    (!forDispatch || claim.deadline_at - now >= MCP_OAUTH_LIMITS.dispatch_headroom_ms)
  );
}
export const McpOAuthFlagsSchema = z.strictObject({
  managed_mcp_oauth_v1: z.boolean(),
  new_starts: z.boolean(),
  exchange: z.boolean(),
  refresh: z.boolean(),
  use_authorization_issuance: z.boolean(),
  revocation: z.boolean(),
});
export const MCP_OAUTH_DISABLED_FLAGS = Object.freeze({
  managed_mcp_oauth_v1: false,
  new_starts: false,
  exchange: false,
  refresh: false,
  use_authorization_issuance: false,
  revocation: false,
});
export const McpOAuthCapabilityRequestSchema = z.strictObject({
  protocol_version: z.literal(1),
  operation_id: McpOAuthIdSchema,
});
/** OAuth issuer identifiers may be an exact HTTPS origin without its trailing slash.
 * Preserve bytes (including pathful issuers); never normalize the profile's identity.
 */
export const McpOAuthIssuerSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return (
        !new URL(value).search &&
        (McpOAuthHttpsUrlSchema.safeParse(value).success ||
          McpOAuthOriginSchema.safeParse(value).success)
      );
    } catch {
      return false;
    }
  }, 'Expected exact HTTPS issuer');
export const McpOAuthScopeTokenSchema = z
  .string()
  .max(256)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);
/** Nonsecret immutable projection, ONLY from the authenticated worker capabilities route.
 * profile_version is semantic_version; catalog_digest is the reviewed registry/Catalog digest.
 * exact_resource_uri binds BOTH the canonical MCP URL and OAuth resource; streamable_http
 * maps to runtime transport http. Scope order is preserved; [] prescribes omission (runtime '').
 * metadata_endpoints is an ordered immutable array bound in full by the runtime fingerprint,
 * not runtime discovery or caller override authority. The legacy metadataUri persistence slot
 * is the sole URL for a singleton, otherwise ''; it cannot select OAuth metadata/authority.
 * No secret-set reference, operational secret version, credentials or registration token.
 */
export const McpOAuthProfileProjectionSchema = z
  .strictObject({
    profile_id: McpOAuthIdSchema,
    profile_version: McpOAuthPositiveEpochSchema,
    catalog_digest: McpOAuthDigestSchema,
    catalog_entry_name: McpOAuthCatalogEntryNameSchema,
    environment: McpOAuthEnvironmentSchema,
    region: McpOAuthRegionSchema,
    exact_resource_uri: McpOAuthHttpsUrlSchema,
    transport: z.literal('streamable_http'),
    metadata_endpoints: z.array(McpOAuthHttpsUrlSchema).max(4),
    issuer: McpOAuthIssuerSchema,
    authorization_endpoint: McpOAuthHttpsUrlSchema,
    token_endpoint: McpOAuthHttpsUrlSchema,
    exact_redirect_uri: McpOAuthHttpsUrlSchema,
    client_id: z.string().min(1).max(2048),
    scope: z.array(McpOAuthScopeTokenSchema).max(32),
    token_endpoint_auth_method: z.enum(['none', 'client_secret_basic', 'client_secret_post']),
    client_kind: z.enum(['public', 'confidential']),
    registration_evidence_digest: McpOAuthDigestSchema,
  })
  .refine(
    (value) => (value.client_kind === 'public') === (value.token_endpoint_auth_method === 'none'),
    'Client kind and authentication method disagree'
  );
export type McpOAuthProfileProjection = z.infer<typeof McpOAuthProfileProjectionSchema>;
export const McpOAuthCapabilitiesSchema = z
  .strictObject({
    protocol_version: z.literal(1),
    binding_version: z.literal(1),
    enforcement_version: z.literal(1),
    available: z.boolean(),
    environment: McpOAuthEnvironmentSchema,
    residency_region: McpOAuthRegionSchema,
    recovery_incarnation: McpOAuthOpaqueSchema.nullable(),
    profile_versions: z.array(McpOAuthProfileProjectionSchema).max(100),
    flags: McpOAuthFlagsSchema,
  })
  .refine(
    (value) =>
      value.available === value.profile_versions.length > 0 &&
      (!value.available || value.recovery_incarnation !== null) &&
      value.profile_versions.every(
        (p) => p.environment === value.environment && p.region === value.residency_region
      ) &&
      new Set(value.profile_versions.map((p) => `${p.profile_id}:${p.profile_version}`)).size ===
        value.profile_versions.length,
    'Inconsistent profile availability, region or identity'
  );
export const McpOAuthInvalidationRequestSchema = z.strictObject({
  protocol_version: z.literal(1),
  operation_id: McpOAuthIdSchema,
  recovery_incarnation: McpOAuthOpaqueSchema,
  cursor: McpOAuthEpochSchema.nullable(),
  snapshot: z.boolean(),
  limit: z.number().int().min(1).max(100),
});
export const McpOAuthInvalidationSchema = z.strictObject({
  cursor: McpOAuthEpochSchema,
  workspace_id: McpOAuthIdSchema,
  recovery_incarnation: McpOAuthOpaqueSchema,
  subject: McpOAuthIdSchema.nullable(),
  handle: McpOAuthOpaqueSchema.nullable(),
  reason: McpOAuthCloseReasonSchema,
  epoch: McpOAuthEpochSchema,
});
export const McpOAuthInvalidationResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  recovery_incarnation: McpOAuthOpaqueSchema,
  snapshot_required: z.boolean(),
  snapshot_complete: z.boolean(),
  next_cursor: McpOAuthEpochSchema,
  items: z.array(McpOAuthInvalidationSchema).max(100),
});
export const McpOAuthPrepareResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  transaction_id: McpOAuthIdSchema,
  expires_at: McpOAuthTimeSchema,
  cancel_epoch: McpOAuthEpochSchema,
});
/** Closed non-vending results; never infer grant commit or provider revocation from ACK/close. */
export const McpOAuthAckResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  acknowledged: z.literal(true),
});
export const McpOAuthCancelResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  canceled: z.literal(true),
});
export const McpOAuthCloseResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  closed: z.literal(true),
  provider_revocation: z.literal('pending'),
  cleanup_authorization_id: McpOAuthIdSchema,
});
export const McpOAuthCleanupResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  closed: z.literal(true),
  provider_revocation: z.enum(['revoked', 'uncertain', 'in_progress']),
});
/** One-use navigation correlation only; full owner is checked, not success authority. */
export const McpOAuthReturnTicketResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  transaction_id: McpOAuthIdSchema,
  owner: McpOAuthOwnerSchema,
});
export const McpOAuthIntentUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        McpOAuthOriginSchema.safeParse(url.origin).success &&
        url.href === value &&
        url.pathname === '/mcp-oauth/continue' &&
        !url.search &&
        /^#ticket=[A-Za-z0-9_-]{43}$/.test(url.hash)
      );
    } catch {
      return false;
    }
  });
export const McpOAuthActivateResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  transaction_id: McpOAuthIdSchema,
  intent_url: McpOAuthIntentUrlSchema,
  expires_at: McpOAuthTimeSchema,
});
export const McpOAuthTransactionStatusSchema = z.strictObject({
  protocol_version: z.literal(1),
  transaction_id: McpOAuthIdSchema,
  owner: McpOAuthOwnerSchema,
  status: z.enum(['reserved', 'waiting', 'callback_ready', 'expired', 'failed', 'canceled']),
  cancel_epoch: McpOAuthEpochSchema,
  expires_at: McpOAuthTimeSchema,
});
export const McpOAuthErrorSchema = z.strictObject({
  error: McpOAuthFailureCodeSchema,
  correlation_id: McpOAuthIdSchema,
});

/** Reject duplicate JSON keys BEFORE schema validation, including escaped spellings. */
export function mcpOAuthParseJson(
  raw: string,
  maximumBytes: number = MCP_OAUTH_LIMITS.request_bytes
): unknown {
  if (utf8ToBytes(raw).length > maximumBytes) throw new Error('managed_oauth_invalid_json');
  let offset = 0;
  let entries = 0;
  const whitespace = () => {
    while (/^[\t\r\n ]$/.test(raw[offset] ?? '')) offset++;
  };
  const string = (): string => {
    const start = offset++;
    for (; offset < raw.length; offset++) {
      if (raw[offset] === '\\') {
        offset++;
        continue;
      }
      if (raw[offset] === '"') {
        offset++;
        return JSON.parse(raw.slice(start, offset));
      }
    }
    throw new Error('managed_oauth_invalid_json');
  };
  const value = (depth: number): unknown => {
    if (depth > 16 || ++entries > 2048) throw new Error('managed_oauth_invalid_json');
    whitespace();
    if (raw[offset] === '"') return string();
    if (raw[offset] === '{') {
      offset++;
      whitespace();
      const result: Record<string, unknown> = Object.create(null);
      if (raw[offset] === '}') {
        offset++;
        return result;
      }
      while (offset < raw.length) {
        whitespace();
        if (raw[offset] !== '"') break;
        const key = string();
        if (Object.hasOwn(result, key)) throw new Error('managed_oauth_duplicate_key');
        whitespace();
        if (raw[offset++] !== ':') break;
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = raw[offset++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') break;
      }
      throw new Error('managed_oauth_invalid_json');
    }
    if (raw[offset] === '[') {
      offset++;
      whitespace();
      const result: unknown[] = [];
      if (raw[offset] === ']') {
        offset++;
        return result;
      }
      while (offset < raw.length) {
        result.push(value(depth + 1));
        whitespace();
        const delimiter = raw[offset++];
        if (delimiter === ']') return result;
        if (delimiter !== ',') break;
      }
      throw new Error('managed_oauth_invalid_json');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      raw.slice(offset)
    );
    if (!token) throw new Error('managed_oauth_invalid_json');
    offset += token[0].length;
    return JSON.parse(token[0]);
  };
  const parsed = value(0);
  whitespace();
  if (offset !== raw.length) throw new Error('managed_oauth_invalid_json');
  return parsed;
}

/** Nonsecret authority snapshot bootstraps Cloud epochs; none of these selectors grants intent. */
export const McpOAuthAuthorityRequestSchema = z.strictObject({
  protocol_version: z.literal(1),
  operation_id: McpOAuthIdSchema,
  workspace_id: McpOAuthIdSchema,
  cloud_user_subject: McpOAuthIdSchema,
  cell_local_user_id: McpOAuthIdSchema,
  server_id: McpOAuthIdSchema,
  attempt_id: McpOAuthIdSchema,
  profile_id: McpOAuthIdSchema,
  profile_version: McpOAuthPositiveEpochSchema,
  catalog_digest: McpOAuthDigestSchema,
  config_fingerprint: McpOAuthDigestSchema,
  grant_generation: McpOAuthEpochSchema,
});
export const McpOAuthAuthorityResponseSchema = z.strictObject({
  protocol_version: z.literal(1),
  owner: McpOAuthOwnerSchema,
});
export type McpOAuthAuthorityRequest = z.infer<typeof McpOAuthAuthorityRequestSchema>;

/** Nonsecret, externally attested cohort evidence. Cell flags/version strings are insufficient. */
export const McpOAuthCellEvidenceSchema = z
  .strictObject({
    cell_id: McpOAuthIdSchema,
    cell_authority_epoch: McpOAuthPositiveEpochSchema,
    recovery_incarnation: McpOAuthOpaqueSchema,
    release_sha: z.string().regex(/^[a-f0-9]{40}$/),
    protocol_version: z.literal(1),
    binding_version: z.literal(1),
    enforcement_version: z.literal(1),
    schema_digest: McpOAuthDigestSchema,
    replicas: z
      .array(
        z.strictObject({
          replica_id: McpOAuthIdSchema,
          release_sha: z.string().regex(/^[a-f0-9]{40}$/),
          protocol_version: z.literal(1),
          binding_version: z.literal(1),
          enforcement_version: z.literal(1),
          schema_digest: McpOAuthDigestSchema,
          gateway_mode: z.literal('enforced'),
        })
      )
      .min(1)
      .max(100),
    expected_replica_count: z.number().int().min(1).max(100),
    pre_gateway_executors_terminated: z.literal(true),
    attestation_digest: McpOAuthDigestSchema,
    approval_reference: McpOAuthIdSchema,
    observed_at: McpOAuthTimeSchema,
    valid_until: McpOAuthTimeSchema,
  })
  .refine(
    (value) =>
      value.replicas.length === value.expected_replica_count &&
      new Set(value.replicas.map((replica) => replica.replica_id)).size === value.replicas.length &&
      value.replicas.every(
        (replica) =>
          replica.release_sha === value.release_sha && replica.schema_digest === value.schema_digest
      ) &&
      value.valid_until > value.observed_at &&
      value.valid_until - value.observed_at <= 120000,
    'Incomplete or mixed managed cohort'
  );

/** Fixed runtime landing route; fragments are cleared before local completion POST. */
export const MCP_OAUTH_RUNTIME_RETURN_PATH = '/mcp-oauth/complete' as const;
export const McpOAuthBrowserFinalizedSchema = z
  .strictObject({
    protocol_version: z.literal(1),
    status: z.literal('waiting_for_cell'),
    transaction_id: McpOAuthIdSchema,
    return_origin: McpOAuthOriginSchema.nullable(),
    return_url: z.string().max(2048).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.return_origin === null && value.return_url === null) return;
    try {
      const url = new URL(value.return_url!);
      const fields = new URLSearchParams(url.hash.slice(1));
      if (
        url.origin !== value.return_origin ||
        url.username ||
        url.password ||
        url.search ||
        url.pathname !== MCP_OAUTH_RUNTIME_RETURN_PATH ||
        [...fields.keys()].join(',') !== 'ticket,transaction_id' ||
        !McpOAuthOpaqueSchema.safeParse(fields.get('ticket')).success ||
        fields.get('transaction_id') !== value.transaction_id ||
        url.href !== value.return_url
      )
        throw new Error('invalid');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid fixed runtime return URL' });
    }
  });
