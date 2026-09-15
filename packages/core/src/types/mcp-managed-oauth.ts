/** Deployment-bound persistence, never a public inventory or portability DTO. */
import { z } from 'zod';
import {
  McpOAuthClaimSchema,
  McpOAuthEpochSchema,
  McpOAuthIdSchema,
  type McpOAuthInvalidationResponseSchema,
  type McpOAuthInvalidationSchema,
  McpOAuthOpaqueSchema,
  McpOAuthOwnerSchema,
  McpOAuthPositiveEpochSchema,
  McpOAuthPrepareRequestSchema,
  McpOAuthReceiptClaimsSchema,
  type McpOAuthRefreshRequest,
  McpOAuthSignedArtifactSchema,
  type McpOAuthTokens,
  McpOAuthUseClaimsSchema,
} from './mcp-managed-oauth-contract';

export const MCPManagedOAuthPendingMetadataSchema = z.strictObject({
  owner: McpOAuthOwnerSchema,
  prepare_request: McpOAuthPrepareRequestSchema,
  cancel_epoch: McpOAuthEpochSchema,
});
export type MCPManagedOAuthPendingMetadata = z.infer<typeof MCPManagedOAuthPendingMetadataSchema>;

/** next_sequence may advance after a certified rejection; the old permit never does. */
export const MCPManagedOAuthGrantMetadataSchema = z.strictObject({
  owner: McpOAuthOwnerSchema,
  transaction_id: McpOAuthIdSchema,
  handle: McpOAuthOpaqueSchema,
  handle_epoch: McpOAuthPositiveEpochSchema,
  next_sequence: McpOAuthPositiveEpochSchema,
  operation_id: McpOAuthIdSchema,
  receipt_id: McpOAuthIdSchema,
  claim: McpOAuthClaimSchema,
  signed_receipt: McpOAuthSignedArtifactSchema,
  receipt_claims: McpOAuthReceiptClaimsSchema,
  use_authorization: McpOAuthSignedArtifactSchema,
  use_claims: McpOAuthUseClaimsSchema,
});
export type MCPManagedOAuthGrantMetadata = z.infer<typeof MCPManagedOAuthGrantMetadataSchema>;

/** Signature/issuer verification precedes this trusted repository input. */
export interface MCPManagedOAuthTokenCommit {
  metadata: MCPManagedOAuthGrantMetadata;
  tokens: McpOAuthTokens;
  expected_sequence: string;
  operation_id: string;
}
/** Transport under the existing runtime refresh claim/CAS owner; never a second owner. */
export interface MCPManagedOAuthRefreshAdapter {
  execute(input: {
    request: McpOAuthRefreshRequest;
    metadata: MCPManagedOAuthGrantMetadata;
    /** Existing claimed operation: receipt lookup only, never resend the refresh token. */
    recoveryOnly: boolean;
    assertCurrent: () => void | Promise<void>;
  }): Promise<MCPManagedOAuthTokenCommit>;
  /** Called only after the atomic local token/receipt/permit transaction committed. */
  acknowledge(commit: MCPManagedOAuthTokenCommit): Promise<void>;
}

export type MCPManagedOAuthInvalidation = z.infer<typeof McpOAuthInvalidationSchema>;
export type MCPManagedOAuthInvalidationPage = z.infer<typeof McpOAuthInvalidationResponseSchema>;

export interface MCPManagedOAuthInvalidationScope {
  tenant_id: string;
  cell_id: string;
  environment: 'staging' | 'production';
  residency_region: 'us-west-2';
  recovery_incarnation: string;
}

export interface MCPManagedOAuthInvalidationRead {
  status: 'ready' | 'snapshot_required' | 'snapshot_staging';
  cursor: string | null;
  /** Every known tombstone remains effective, including during snapshot staging. */
  items: MCPManagedOAuthInvalidation[];
}

/** Wire epochs are bigint decimal strings. Existing local generation columns are not. */
export function managedOAuthLocalGeneration(value: string): number {
  McpOAuthEpochSchema.parse(value);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe managed OAuth local generation');
  return number;
}

export function managedOAuthWireGeneration(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid OAuth local generation');
  return String(value);
}

/** Nonsecret immutable registry projection; never a caller client override. */
export interface MCPManagedOAuthResolvedProfile {
  reference: import('./mcp').MCPManagedOAuthProfileReference;
  catalogEntryName: string;
  mcpUrl: string;
  transport: 'http';
  metadataUri: string;
  resourceUri: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  clientId: string;
  scope: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  clientKind: 'public' | 'confidential';
  registrationProvenanceDigest: string;
}
