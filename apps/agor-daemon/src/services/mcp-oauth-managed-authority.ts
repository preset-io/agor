import { randomUUID } from 'node:crypto';
import {
  executeRaw,
  getMCPEgressGatewayMode,
  isPostgresDatabaseHandle,
  MCPServerRepository,
  rawRows,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import {
  hasMinimumRole,
  type MCPManagedOAuthGrantMetadata,
  McpOAuthAckRequestSchema,
  McpOAuthAckResponseSchema,
  McpOAuthIdSchema,
  type McpOAuthOwner,
  mcpOAuthLengthPrefix,
  mcpOAuthOwnerBytes,
  mcpOAuthSha256,
  ROLES,
  type UserID,
} from '@agor/core/types';
import { persistOAuthToken } from '../oauth-cache.js';
import {
  fingerprintManagedMCPOAuthGrantConfiguration,
  lockMCPOAuthGrantConfiguration,
} from './mcp-oauth-grant-binding.js';
import { ManagedOAuthUnavailableError } from './mcp-oauth-managed-errors.js';
import type { ManagedOAuthRuntimeDependencies } from './mcp-oauth-managed-runtime.js';

/** Nonsecret deployment identity provider, never a request-selected issuer. */
export interface ManagedOAuthLocalIdentityPolicy {
  provider: string;
  issuer: string;
}

/**
 * The normalized external-identity relation is authority, not users.data,
 * email, an executor claim or a browser-supplied Cloud subject. Locks retain
 * exact role/identity through the enclosing local write transaction.
 */
export async function resolveManagedOAuthLocalSubject(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  tenantId: string,
  userId: UserID,
  policy: ManagedOAuthLocalIdentityPolicy
): Promise<string> {
  if (!isPostgresDatabaseHandle(db) || !tenantId || !userId || !policy.provider || !policy.issuer) {
    throw new Error('Managed MCP OAuth requires trusted cell identity');
  }
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const rows = rawRows(
      await executeRaw(
        scoped,
        sql`
      SELECT i.subject, u.role
      FROM user_external_identities i
      JOIN users u ON u.tenant_id = i.tenant_id AND u.user_id = i.user_id
      WHERE i.tenant_id = ${tenantId} AND i.user_id = ${userId}
        AND i.provider = ${policy.provider} AND i.issuer = ${policy.issuer}
      FOR SHARE OF u, i
    `
      )
    );
    if (rows.length !== 1 || !hasMinimumRole(String(rows[0].role), ROLES.MEMBER)) {
      throw new Error('Managed MCP OAuth subject is unavailable');
    }
    const subject = McpOAuthIdSchema.safeParse(rows[0].subject);
    if (!subject.success) throw new Error('Managed MCP OAuth subject is unavailable');
    return subject.data;
  });
}

export async function assertManagedOAuthLocalOwner(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  tenantId: string,
  userId: UserID,
  policy: ManagedOAuthLocalIdentityPolicy,
  owner: McpOAuthOwner
): Promise<void> {
  if (owner.workspace_id !== tenantId || owner.cell_local_user_id !== userId) {
    throw new Error('Managed MCP OAuth local owner changed');
  }
  const subject = await resolveManagedOAuthLocalSubject(db, tenantId, userId, policy);
  if (subject !== owner.cloud_user_subject)
    throw new Error('Managed MCP OAuth local owner changed');
}

/** Composition of the existing token persistence owner; no second managed token store. */

export function createManagedOAuthPersistence(options: {
  db: TenantScopeAwareDatabase;
  masterSecret: string;
  identity: ManagedOAuthLocalIdentityPolicy;
  /** Cached authenticated registry plus fresh local cohort/clock; MUST NOT perform external I/O. */
  assertAdmission: (input: Parameters<ManagedOAuthRuntimeDependencies['persist']>[0]) => void;
}): ManagedOAuthRuntimeDependencies['persist'] {
  return async (input) => {
    const { record, profile, commit } = input;
    const owner = commit.metadata.owner;
    if (
      !record.managedMetadata ||
      record.credentialOrigin !== 'cloud_managed_v1' ||
      !Buffer.from(mcpOAuthOwnerBytes(record.managedMetadata.owner)).equals(
        Buffer.from(mcpOAuthOwnerBytes(owner))
      ) ||
      record.managedTransactionId !== commit.metadata.transaction_id ||
      record.exchangeClaimId !== commit.metadata.claim.claim_id ||
      record.managedOperationId !== commit.operation_id
    )
      throw new ManagedOAuthUnavailableError();
    options.assertAdmission(input);
    await runWithTenantDatabaseScope(options.db, record.tenantId, async (db) => {
      await lockMCPOAuthGrantConfiguration(db, record.tenantId, record.mcpServerId);
      const server = await new MCPServerRepository(db).findById(record.mcpServerId);
      if (
        (await getMCPEgressGatewayMode(db)) !== 'enforced' ||
        !server ||
        server.owner_user_id !== record.userId
      )
        throw new ManagedOAuthUnavailableError();
      await assertManagedOAuthLocalOwner(
        db,
        record.tenantId,
        record.userId,
        options.identity,
        owner
      );
      const fingerprint = fingerprintManagedMCPOAuthGrantConfiguration(
        options.masterSecret,
        server,
        profile,
        {
          tenantId: record.tenantId,
          userId: record.userId,
          cloudSubject: owner.cloud_user_subject,
          grantGeneration: String(record.grantGeneration),
        }
      );
      if (fingerprint !== record.configFingerprint || fingerprint !== owner.config_fingerprint)
        throw new ManagedOAuthUnavailableError();
      options.assertAdmission(input);
      // Pass this exact native transaction: managed subject locking refuses a detached/proxy handle.
      await persistOAuthToken(
        db,
        commit.tokens,
        {
          mcpServerId: record.mcpServerId,
          userId: record.userId,
          oauthMode: 'per_user',
          clientId: profile.clientId,
          tokenEndpointAuthMethod:
            profile.tokenEndpointAuthMethod === 'none'
              ? undefined
              : profile.tokenEndpointAuthMethod,
          grantBinding: {
            generation: record.grantGeneration,
            version: 5,
            fingerprint,
            metadataUri: profile.metadataUri,
            resourceUri: profile.resourceUri,
            issuer: profile.issuer,
            authorizationEndpoint: profile.authorizationEndpoint,
            tokenEndpoint: profile.tokenEndpoint,
            redirectUri: profile.redirectUri,
          },
          managed: commit,
        },
        'Managed OAuth'
      );
      // saveToken's SQL receipt/claim CAS completes pending in this same transaction.
      // Never call the direct finish helper afterward or ACK before this commits.
    });
  };
}

/** This identifies the committed receipt, not the possibly later broker sequence cursor. */
export function managedOAuthReceiptCommitFence(metadata: MCPManagedOAuthGrantMetadata): string {
  return mcpOAuthSha256(
    mcpOAuthLengthPrefix([
      'agor:mcp-oauth:committed-receipt:v1',
      mcpOAuthSha256(mcpOAuthOwnerBytes(metadata.owner)),
      metadata.receipt_id,
      metadata.operation_id,
      metadata.receipt_claims.next_sequence,
    ])
  );
}

/** Caller must obtain metadata from a completed local commit or committed-only repository read. */
export function createManagedOAuthAcknowledger(input: {
  db: TenantScopeAwareDatabase;
  sender: Pick<ManagedMCPOAuthClient, 'request'>;
  assertOwner(
    owner: McpOAuthOwner,
    budget?: { timeoutMs?: number; signal?: AbortSignal }
  ): void | Promise<void>;
}) {
  return async (
    metadata: MCPManagedOAuthGrantMetadata,
    execution?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      assertCurrent?: () => void | Promise<void>;
    }
  ): Promise<void> => {
    if (execution?.signal?.aborted) throw new Error('Managed ACK stopped');
    await execution?.assertCurrent?.();
    if (execution?.timeoutMs !== undefined && execution.timeoutMs <= 0)
      throw new Error('Managed ACK budget exhausted');
    await input.sender.request({
      operation: 'ack',
      id: metadata.operation_id,
      body: McpOAuthAckRequestSchema.parse({
        protocol_version: 1,
        operation_id: randomUUID(),
        owner: metadata.owner,
        target_operation_id: metadata.operation_id,
        receipt_id: metadata.receipt_id,
        claim: metadata.claim,
        cell_commit_fence: managedOAuthReceiptCommitFence(metadata),
      }),
      schema: McpOAuthAckResponseSchema,
      recovery: true,
      timeoutMs: execution?.timeoutMs,
      assertCurrent: async () => {
        await execution?.assertCurrent?.();
        if (execution?.signal?.aborted) throw new Error('Managed ACK stopped');
        await input.assertOwner(metadata.owner, execution);
        await execution?.assertCurrent?.();
      },
    });
    // The worker's authenticated ACK is delivery evidence, not grant authority.
    // A failed local write is retried; a late ACK can mark only this exact receipt.
    await runWithTenantDatabaseScope(input.db, metadata.owner.workspace_id, (db) =>
      new UserMCPOAuthTokenRepository(db).markManagedReceiptAcknowledged(metadata)
    );
  };
}
