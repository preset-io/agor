/** Composition of the existing token persistence owner; no second managed token store. */
import {
  getMCPEgressGatewayMode,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { mcpOAuthOwnerBytes } from '@agor/core/types';
import { persistOAuthToken } from '../oauth-cache.js';
import {
  fingerprintManagedMCPOAuthGrantConfiguration,
  lockMCPOAuthGrantConfiguration,
} from './mcp-oauth-grant-binding.js';
import {
  assertManagedOAuthLocalOwner,
  type ManagedOAuthLocalIdentityPolicy,
} from './mcp-oauth-managed-identity.js';
import {
  type ManagedOAuthRuntimeDependencies,
  ManagedOAuthUnavailableError,
} from './mcp-oauth-managed-runtime.js';

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
