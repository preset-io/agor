import { runWithTenantDatabaseScope, UserMCPOAuthTokenRepository } from '@agor/core/db';
import { findCatalogEntry, loadCatalog } from '@agor/core/mcp-catalog';
import { assertMcpGrantSubjectEntitled } from '@agor/core/tools/mcp/grant-entitlement';
import {
  AmbiguousRefreshError,
  GrantConfigurationChangedError,
  getManagedOAuthDeferredRefresh,
  MissingRefreshTokenError,
  needsRefresh,
  type RefreshAndPersistDeps,
  refreshAndPersistToken,
} from '@agor/core/tools/mcp/oauth-refresh';
import type { MCPCatalogEntry, MCPServer } from '@agor/core/types';
import { catalogOAuthConfig, isCurrentCatalogInstall } from './mcp-catalog-install-policy.js';

/** A live newer rotation is contention, not lost authorization. */
export class MCPOAuthRefreshBusyError extends Error {
  constructor() {
    super('OAuth access changed during refresh. Retry using the current grant.');
    this.name = 'MCPOAuthRefreshBusyError';
  }
}

/** Ephemeral machine tokens are not durable browser grants. */
export class MCPClientCredentialsConfigurationError extends Error {
  constructor() {
    super('Saved client-credentials OAuth requires a supported authentication configuration.');
    this.name = 'MCPClientCredentialsConfigurationError';
  }
}

export async function missingMCPOAuthGrantError(
  server: Pick<
    MCPServer,
    'source' | 'catalog_entry_name' | 'transport' | 'url' | 'auth' | 'headers'
  >
): Promise<Error> {
  const auth = server.auth;
  // A canonical configured-client recipe prescribes browser authorization,
  // not machine-token minting. Only the saved definition can establish this;
  // a client ID/secret, endpoint, or historical catalog stamp alone cannot.
  if (!auth?.oauth_grant_type && server.source === 'catalog' && server.catalog_entry_name) {
    const entry = findCatalogEntry(await loadCatalog(), server.catalog_entry_name);
    if (
      entry?.remote_url &&
      entry.auth_type === 'oauth' &&
      entry.oauth?.configured_client === true &&
      isCurrentCatalogInstall(
        server,
        entry as MCPCatalogEntry & { remote_url: string },
        catalogOAuthConfig(entry)
      )
    ) {
      return new MissingRefreshTokenError();
    }
  }
  // Legacy forms defaulted an omitted grant type to client_credentials. Do not
  // mint a machine token here: a missing row can also be a retired browser grant.
  if (
    auth?.oauth_grant_type === 'client_credentials' ||
    (!auth?.oauth_grant_type && auth?.oauth_client_id && auth.oauth_client_secret)
  ) {
    return new MCPClientCredentialsConfigurationError();
  }
  return new MissingRefreshTokenError();
}

/**
 * One use-time boundary for execution and capability discovery. Never call
 * from inventory: obtaining a usable grant can rotate provider credentials.
 * External I/O stays outside short tenant database units, and the returned
 * row is the exact committed grant (needed by discovery's publication fence).
 */
export async function acquireMCPOAuthGrant(
  deps: Omit<RefreshAndPersistDeps, 'observedRefreshVersion'>
) {
  const read = () =>
    runWithTenantDatabaseScope(deps.db, deps.tenantId, async (db) => {
      const grant = await new UserMCPOAuthTokenRepository(db).getToken(
        deps.userId,
        deps.mcpServerId
      );
      if (grant && !(await deps.validateGrant(grant, db))) {
        throw new GrantConfigurationChangedError();
      }
      return grant;
    });
  const grant = await read();
  if (!grant) return null;
  if (grant.refresh_status === 'ambiguous') throw new AmbiguousRefreshError();
  // A token may outlive its fixed co-issued permit; refresh before the earlier deadline.
  const managed = grant.credential_origin === 'cloud_managed_v1';
  if (managed && (!deps.managed || !grant.managed_metadata))
    throw new GrantConfigurationChangedError();
  const effectiveExpiry = managed
    ? new Date(
        Math.min(
          grant.oauth_token_expires_at?.getTime() ?? 0,
          grant.managed_metadata!.use_claims.expires_at
        )
      )
    : grant.oauth_token_expires_at;
  if (
    grant.refresh_status === 'refreshing' ||
    (needsRefresh(effectiveExpiry) && grant.oauth_refresh_token)
  ) {
    await runWithTenantDatabaseScope(deps.db, deps.tenantId, (db) =>
      assertMcpGrantSubjectEntitled({
        db,
        tenantId: deps.tenantId,
        subjectUserId: deps.userId,
        oauthMode: deps.userId === null ? 'shared' : 'per_user',
      })
    );
    let accessToken: string;
    try {
      accessToken = await refreshAndPersistToken({
        ...deps,
        observedRefreshVersion: {
          grantGeneration: grant.grant_generation,
          grantBindingFingerprint: grant.grant_binding_fingerprint,
          refreshGeneration: grant.refresh_generation,
        },
      });
    } catch (error) {
      const certified = managed && getManagedOAuthDeferredRefresh(error);
      if (!certified) throw error;
      const retained = await read();
      // Distinct from successful rotation: a certified unconsumed attempt may
      // advance the attempt/sequence, but never the successful generation,
      // access token or original signed use authorization. No ambiguous or
      // concurrently replaced/claimed row can be retained through this path.
      if (
        retained?.credential_origin !== 'cloud_managed_v1' ||
        retained.refresh_status !== 'idle' ||
        retained.grant_generation !== grant.grant_generation ||
        retained.grant_generation !== certified.grantGeneration ||
        retained.grant_binding_fingerprint !== grant.grant_binding_fingerprint ||
        retained.grant_binding_fingerprint !== certified.grantBindingFingerprint ||
        retained.refresh_generation !== certified.refreshGeneration ||
        retained.refresh_success_generation !== grant.refresh_success_generation ||
        !retained.oauth_access_token ||
        retained.oauth_access_token !== grant.oauth_access_token ||
        !retained.managed_metadata ||
        retained.managed_metadata.use_authorization !== grant.managed_metadata!.use_authorization ||
        !retained.oauth_token_expires_at ||
        retained.oauth_token_expires_at.getTime() <= Date.now() ||
        retained.managed_metadata.use_claims.expires_at <= Date.now()
      )
        throw error;
      await deps.assertCurrent?.();
      return retained;
    }
    const committed = await read();
    if (
      !committed ||
      committed.grant_generation !== grant.grant_generation ||
      committed.grant_binding_fingerprint !== grant.grant_binding_fingerprint ||
      committed.refresh_generation < grant.refresh_generation
    ) {
      throw new GrantConfigurationChangedError();
    }
    if (committed.refresh_status === 'ambiguous') throw new AmbiguousRefreshError();
    // Another replica may have claimed/completed the next rotation after our
    // exchange committed. Never vend the superseded token or replay a refresh.
    // A successful newer idle row is authoritative; an active/failed newer
    // claim is retryable contention, not a configuration/reauthentication error.
    if (
      committed.refresh_status !== 'idle' ||
      committed.refresh_success_generation !== committed.refresh_generation ||
      !committed.oauth_access_token ||
      (committed.oauth_access_token !== accessToken &&
        committed.refresh_success_generation <= grant.refresh_generation) ||
      (committed.oauth_token_expires_at && committed.oauth_token_expires_at.getTime() <= Date.now())
    ) {
      throw new MCPOAuthRefreshBusyError();
    }
    if (
      managed &&
      (!committed.managed_metadata ||
        committed.managed_metadata.use_claims.expires_at <= Date.now())
    )
      throw new MCPOAuthRefreshBusyError();
    return committed;
  }
  if (!grant.oauth_access_token || (effectiveExpiry && effectiveExpiry.getTime() <= Date.now())) {
    throw new MissingRefreshTokenError();
  }
  return grant;
}
