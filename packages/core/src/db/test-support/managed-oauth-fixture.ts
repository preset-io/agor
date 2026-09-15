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

/** Real tenant transaction fixture for the existing refresh owner integration. */
export async function seedManagedRefreshGrant(
  db: import('../client').Database,
  masterSecret: string,
  tenantOverride?: string,
  cellId?: string
) {
  const { runWithTenantDatabaseScope } = await import('../tenant-scope');
  const { executeRaw } = await import('../database-wrapper');
  const { sql } = await import('drizzle-orm');
  const { UsersRepository } = await import('../repositories/users');
  const { MCPServerRepository } = await import('../repositories/mcp-servers');
  const { MCPOAuthPendingFlowRepository } = await import('../repositories/mcp-oauth-pending-flows');
  const { UserMCPOAuthTokenRepository } = await import('../repositories/user-mcp-oauth-tokens');
  const { createHash } = await import('node:crypto');
  const tenant = tenantOverride ?? `refresh-${randomUUID()}`;
  return runWithTenantDatabaseScope(db, tenant, async (db) => {
    const user = await new UsersRepository(db).create({
      email: `${randomUUID()}@example.test`,
      role: 'member',
    });
    const cloudSubject = cellId === undefined ? 'cloud-subject' : `cloud-${user.user_id}`;
    await executeRaw(
      db,
      sql`INSERT INTO public.user_external_identities (tenant_id,identity_key,user_id,provider,issuer,subject,last_login_at,created_at,updated_at)
      VALUES (${tenant},${randomUUID()},${user.user_id},'cloud','https://cloud.example.test/',${cloudSubject},clock_timestamp(),clock_timestamp(),clock_timestamp())`
    );
    const server = await new MCPServerRepository(db).create({
      name: 'Managed synthetic',
      transport: 'http',
      url: 'https://provider.example.test/mcp',
      scope: 'global',
      enabled: true,
      source: 'user',
      owner_user_id: user.user_id,
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_client_mode: 'cloud_managed_v1',
        oauth_managed_profile: {
          profile_id: 'profile',
          semantic_version: '1',
          environment: 'staging',
          region: 'us-west-2',
          registry_digest: 'b'.repeat(64),
        },
      },
    });
    const pending = new MCPOAuthPendingFlowRepository(db);
    const subject = {
      tenantId: tenant,
      userId: user.user_id,
      mcpServerId: server.mcp_server_id,
      oauthMode: 'per_user' as const,
      subjectUserId: user.user_id,
    };
    const generation = await pending.allocateGrantGeneration(subject);
    const attempt = randomUUID() as import('../../types').MCPOAuthAttemptID;
    const owner = managedOwner({
      tenant,
      user: user.user_id,
      server: server.mcp_server_id,
      attempt,
      generation,
    });
    if (cellId !== undefined) owner.cell_id = cellId;
    owner.cloud_user_subject = cloudSubject;
    const transaction = randomUUID();
    await pending.create({
      ...subject,
      attemptId: attempt,
      stateHash: createHash('sha256').update(`agor-mcp-managed-v1\0${transaction}`).digest('hex'),
      grantGeneration: generation,
      configFingerprintVersion: 5,
      configFingerprint: owner.config_fingerprint,
      envelopeVersion: 1,
      sealedMaterial: 'synthetic-envelope',
      ttlMs: 600000,
      managedTransactionId: transaction,
      managedMetadata: {
        owner,
        cancel_epoch: '0',
        prepare_request: {
          protocol_version: 1,
          operation_id: randomUUID(),
          owner,
          catalog_entry_name: 'synthetic',
          pkce_challenge: 'P'.repeat(43),
          method: 'S256',
          client_nonce_hash: 'c'.repeat(64),
          replacement_handle: null,
        },
      },
    });
    const result = await pending.claimManagedForTenant(
      (await pending.getForUser(tenant, user.user_id, attempt))!,
      randomUUID()
    );
    if (result.outcome !== 'claimed') throw new Error('Fixture exchange claim failed');
    const start = result.flow.exchangeStartedAt!.getTime();
    const commit = managedCommit(
      owner,
      {
        kind: 'exchange',
        claim_id: result.flow.exchangeClaimId!,
        claimed_at: start,
        deadline_at: start + 120000,
        refresh_generation: '0',
        refresh_success_generation: '0',
      },
      '0',
      cellId === undefined
        ? undefined
        : createHash('sha256').update(randomUUID()).digest('base64url')
    );
    commit.metadata.transaction_id = transaction;
    await new UserMCPOAuthTokenRepository(db, masterSecret).saveToken(
      user.user_id,
      server.mcp_server_id,
      {
        accessToken: commit.tokens.access_token,
        refreshToken: commit.tokens.refresh_token,
        expiresAt: new Date(commit.tokens.expires_at),
        clientId: 'public-platform-id',
        managed: commit,
        grantBinding: {
          version: 5,
          generation,
          fingerprint: owner.config_fingerprint,
          metadataUri: 'https://provider.example.test/metadata',
          resourceUri: server.url!,
          issuer: 'https://provider.example.test/',
          authorizationEndpoint: 'https://provider.example.test/auth',
          tokenEndpoint: 'https://provider.example.test/token',
          redirectUri: 'https://broker.example.test/callback',
        },
      }
    );
    return {
      tenant,
      user: user.user_id,
      server: server.mcp_server_id,
      owner,
      commit,
      expected: {
        grantGeneration: generation,
        grantBindingFingerprint: owner.config_fingerprint,
        refreshGeneration: 0,
      },
    };
  });
}
