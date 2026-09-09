import { runWithTenantDatabaseScope, UserMCPOAuthTokenRepository } from '@agor/core/db';
import { assertMcpGrantSubjectEntitled } from '@agor/core/tools/mcp/grant-entitlement';
import {
  AmbiguousRefreshError,
  GrantConfigurationChangedError,
  MissingRefreshTokenError,
  needsRefresh,
  type RefreshAndPersistDeps,
  refreshAndPersistToken,
} from '@agor/core/tools/mcp/oauth-refresh';
import type { MCPAuth } from '@agor/core/types';

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

export function missingMCPOAuthGrantError(auth: MCPAuth): Error {
  // Legacy forms defaulted an omitted grant type to client_credentials. Do not
  // mint a machine token here: a missing row can also be a retired browser grant.
  if (
    auth.oauth_grant_type === 'client_credentials' ||
    (!auth.oauth_grant_type && auth.oauth_client_id && auth.oauth_client_secret)
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
  if (
    grant.refresh_status === 'refreshing' ||
    (needsRefresh(grant.oauth_token_expires_at) && grant.oauth_refresh_token)
  ) {
    await runWithTenantDatabaseScope(deps.db, deps.tenantId, (db) =>
      assertMcpGrantSubjectEntitled({
        db,
        tenantId: deps.tenantId,
        subjectUserId: deps.userId,
        oauthMode: deps.userId === null ? 'shared' : 'per_user',
      })
    );
    const accessToken = await refreshAndPersistToken({
      ...deps,
      observedRefreshVersion: {
        grantGeneration: grant.grant_generation,
        grantBindingFingerprint: grant.grant_binding_fingerprint,
        refreshGeneration: grant.refresh_generation,
      },
    });
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
    return committed;
  }
  if (
    !grant.oauth_access_token ||
    (grant.oauth_token_expires_at && grant.oauth_token_expires_at.getTime() <= Date.now())
  ) {
    throw new MissingRefreshTokenError();
  }
  return grant;
}
