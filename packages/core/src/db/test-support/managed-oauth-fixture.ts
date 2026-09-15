/** Synthetic persistence fixtures, not proof of the separate JWS verification adapter. */
import { randomUUID } from 'node:crypto';
import type { MCPManagedOAuthTokenCommit } from '../../types/mcp-managed-oauth';
import type { McpOAuthClaim, McpOAuthOwner } from '../../types/mcp-managed-oauth-contract';
import { mcpOAuthSha256, mcpOAuthTokensDigest } from '../../types/mcp-managed-oauth-contract';
export function managedOwner(input: {
  tenant: string;
  user: string;
  server: string;
  attempt: string;
  generation: number;
}): McpOAuthOwner {
  return {
    environment: 'staging',
    residency_region: 'us-west-2',
    recovery_incarnation: 'I'.repeat(43),
    workspace_id: input.tenant,
    cloud_user_subject: 'cloud-subject',
    cell_local_user_id: input.user,
    server_id: input.server,
    attempt_id: input.attempt,
    profile_id: 'profile',
    profile_version: '1',
    catalog_digest: 'b'.repeat(64),
    config_fingerprint: 'a'.repeat(64),
    grant_generation: String(input.generation),
    membership_id: 'membership',
    cell_id: 'cell',
    data_plane_id: 'plane',
    placement_epoch: '1',
    identity_epoch: '1',
    user_identity_epoch: '1',
    cell_authority_epoch: '1',
    data_plane_authority_epoch: '1',
  };
}
export function managedCommit(
  owner: McpOAuthOwner,
  claim: McpOAuthClaim,
  sequence = '0',
  handle = 'H'.repeat(43)
): MCPManagedOAuthTokenCommit {
  const now = Date.now();
  const tokens = {
    access_token: `synthetic-access-${randomUUID()}`,
    refresh_token: `synthetic-refresh-${randomUUID()}`,
    token_type: 'Bearer' as const,
    expires_at: now + 3600000,
    scope: null,
  };
  const shared = {
    protocol_version: 1 as const,
    binding_version: 1 as const,
    enforcement_version: 1 as const,
    iss: 'https://broker.example.test/',
    aud: 'cell',
    owner,
    claim,
    operation_id: claim.claim_id,
    receipt_id: randomUUID(),
    handle,
    handle_epoch: '1',
    sequence,
    next_sequence: String(BigInt(sequence) + 1n),
    token_digest: mcpOAuthSha256(tokens.access_token),
    issued_at: now,
  };
  const use_authorization = 'synthetic.use.signature';
  const use_claims = {
    ...shared,
    kind: 'mcp_oauth_use' as const,
    expires_at: now + 3595000,
    token_expires_at: tokens.expires_at,
  };
  const receipt_claims = {
    ...shared,
    kind: 'mcp_oauth_receipt' as const,
    expires_at: now + 600000,
    tokens_digest: mcpOAuthTokensDigest(tokens),
    use_authorization_digest: mcpOAuthSha256(use_authorization),
  };
  return {
    tokens,
    operation_id: claim.claim_id,
    expected_sequence: sequence,
    metadata: {
      owner,
      transaction_id: 'transaction',
      handle,
      handle_epoch: '1',
      next_sequence: shared.next_sequence,
      operation_id: claim.claim_id,
      receipt_id: shared.receipt_id,
      claim,
      signed_receipt: 'synthetic.receipt.signature',
      receipt_claims,
      use_authorization,
      use_claims,
    },
  };
}
