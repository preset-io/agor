import {
  MCPManagedOAuthGrantMetadataSchema,
  type MCPManagedOAuthTokenCommit,
} from '../../types/mcp-managed-oauth';
import {
  McpOAuthTokensSchema,
  mcpOAuthOwnerBytes,
  mcpOAuthSha256,
  mcpOAuthTokensDigest,
} from '../../types/mcp-managed-oauth-contract';
import { RepositoryError } from './base';

/** Persistence-side structural/row binding; cryptographic JWS verification is the adapter's gate. */
export function assertManagedOAuthTokenCommit(
  input: MCPManagedOAuthTokenCommit,
  expected: {
    tenantId: string;
    userId: string | null;
    serverId: string;
    generation: number;
    fingerprint?: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date | null;
  }
): void {
  const m = MCPManagedOAuthGrantMetadataSchema.parse(input.metadata);
  const tokens = McpOAuthTokensSchema.parse(input.tokens);
  const r = m.receipt_claims;
  const u = m.use_claims;
  const ownerDigest = mcpOAuthSha256(mcpOAuthOwnerBytes(m.owner));
  const claim = JSON.stringify(m.claim);
  if (
    m.owner.workspace_id !== expected.tenantId ||
    m.owner.cell_local_user_id !== expected.userId ||
    m.owner.server_id !== expected.serverId ||
    m.owner.grant_generation !== String(expected.generation) ||
    (expected.fingerprint !== undefined && m.owner.config_fingerprint !== expected.fingerprint) ||
    tokens.access_token !== expected.accessToken ||
    tokens.refresh_token !== expected.refreshToken ||
    tokens.expires_at !== expected.expiresAt?.getTime() ||
    m.operation_id !== input.operation_id ||
    r.sequence !== input.expected_sequence ||
    m.next_sequence !== r.next_sequence ||
    m.next_sequence !== u.next_sequence ||
    m.handle !== r.handle ||
    m.handle !== u.handle ||
    m.handle_epoch !== r.handle_epoch ||
    m.handle_epoch !== u.handle_epoch ||
    m.receipt_id !== r.receipt_id ||
    m.receipt_id !== u.receipt_id ||
    m.operation_id !== r.operation_id ||
    m.operation_id !== u.operation_id ||
    mcpOAuthSha256(mcpOAuthOwnerBytes(r.owner)) !== ownerDigest ||
    mcpOAuthSha256(mcpOAuthOwnerBytes(u.owner)) !== ownerDigest ||
    JSON.stringify(r.claim) !== claim ||
    JSON.stringify(u.claim) !== claim ||
    r.token_digest !== mcpOAuthSha256(tokens.access_token) ||
    u.token_digest !== r.token_digest ||
    u.token_expires_at !== tokens.expires_at ||
    r.tokens_digest !== mcpOAuthTokensDigest(tokens) ||
    r.use_authorization_digest !== mcpOAuthSha256(m.use_authorization)
  ) {
    throw new RepositoryError('Managed OAuth receipt does not match its exact token/owner/fence');
  }
}
