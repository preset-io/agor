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
      committed.refresh_status !== 'idle' ||
      committed.oauth_access_token !== accessToken
    ) {
      throw new GrantConfigurationChangedError();
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
