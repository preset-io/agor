/**
 * MCP OAuth Token Repository
 *
 * Unified storage for both per-user and shared-mode OAuth tokens.
 *   - `user_id` set  → per-user token (oauth_mode: 'per_user')
 *   - `user_id` NULL → shared-mode token for that MCP server (oauth_mode: 'shared')
 *
 * DCR / registered client credentials are co-located with the refresh_token
 * because refreshing requires the exact client_id/client_secret the grant was
 * issued under.
 */

import { randomUUID } from 'node:crypto';
import type { MCPServerID, UserID } from '@agor/core/types';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  deleteFrom,
  executeRaw,
  insert,
  isPostgresDatabase,
  select,
  update,
} from '../database-wrapper';
import { openMCPOAuthSecret, sealMCPOAuthSecret } from '../oauth-secret-envelope';
import {
  type UserMCPOAuthTokenInsert,
  type UserMCPOAuthTokenRow,
  userMcpOauthTokens,
} from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';

/**
 * MCP OAuth token record. `user_id` is null for shared-mode rows.
 */
export interface UserMCPOAuthToken {
  user_id: UserID | null;
  mcp_server_id: MCPServerID;
  oauth_access_token: string;
  oauth_token_expires_at?: Date;
  oauth_refresh_token?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  grant_generation: number;
  grant_binding_version?: number;
  grant_binding_fingerprint?: string;
  oauth_metadata_uri?: string;
  oauth_resource_uri?: string;
  oauth_issuer?: string;
  oauth_authorization_endpoint?: string;
  oauth_token_endpoint?: string;
  oauth_redirect_uri?: string;
  refresh_status: 'idle' | 'refreshing' | 'ambiguous';
  refresh_generation: number;
  refresh_success_generation: number;
  refresh_claim_id?: string;
  refresh_claimed_at?: Date;
  created_at: Date;
  updated_at?: Date;
}

/** Input shape for `saveToken`. */
export interface SaveTokenInput {
  accessToken: string;
  /**
   * Absolute expiry, as resolved by `resolveTokenExpiry`. Three states:
   *   - `Date`     → write that timestamp to `oauth_token_expires_at`
   *   - `null`     → explicitly write `NULL` ("expiry unknown — provider gave
   *                   no hint we could decode"). Surfaces as "expires in:
   *                   unknown" in the UI.
   *   - `undefined`→ preserve any existing value on update; absent on insert
   *
   * The `null` vs `undefined` distinction matters: the previous code used a
   * truthy check that conflated the two, which produced asymmetric defaulting
   * between the initial-auth and refresh persist sites. See
   * `context/explorations/mcp-oauth-token-lifecycle.md` (Phase 3.5).
   *
   * The repository takes an absolute `Date` rather than a relative TTL so
   * OAuth-spec semantics (cascade, JWT decode, etc.) stay in the resolver and
   * out of the storage layer.
   */
  expiresAt?: Date | null;
  /** If absent on update, the existing refresh_token is kept. */
  refreshToken?: string;
  /** If absent on update, the existing client_id is kept. */
  clientId?: string;
  /** If absent on update, the existing client_secret is kept. */
  clientSecret?: string;
  /** Required for every new PostgreSQL grant and checked on replacement. */
  grantBinding?: {
    generation: number;
    version: 1;
    fingerprint: string;
    metadataUri: string;
    resourceUri: string;
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    redirectUri: string;
  };
}

export type MCPOAuthRefreshClaimResult =
  | {
      outcome: 'claimed';
      token: UserMCPOAuthToken;
      claimId: string;
      refreshGeneration: number;
      grantGeneration: number;
    }
  | { outcome: 'observed'; token: UserMCPOAuthToken | null };

export interface MCPOAuthRefreshVersion {
  grantGeneration: number;
  refreshGeneration: number;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function grantSecretBinding(
  tenantId: string,
  userId: UserID | null,
  serverId: MCPServerID,
  generation: number,
  field: string
): string {
  return [tenantId, userId ?? '<shared>', serverId, String(generation), field].join('\0');
}

function rowToToken(
  row: UserMCPOAuthTokenRow,
  options: { postgres: boolean; tenantId?: string; masterSecret?: string }
): UserMCPOAuthToken {
  const raw = row as UserMCPOAuthTokenRow & Record<string, unknown>;
  const userId = (row.user_id as UserID | null) ?? null;
  const serverId = row.mcp_server_id as MCPServerID;
  const generation = Number(raw.grant_generation ?? 0);
  const open = (
    value: unknown,
    purpose: 'access-token' | 'refresh-token' | 'client-id' | 'client-secret',
    field: string
  ) => {
    if (value == null || value === '') return undefined;
    if (!options.postgres) return String(value);
    if (!options.tenantId || !options.masterSecret) {
      throw new RepositoryError('PostgreSQL MCP OAuth token decryption is not configured');
    }
    return openMCPOAuthSecret(
      String(value),
      options.masterSecret,
      purpose,
      grantSecretBinding(options.tenantId, userId, serverId, generation, field)
    );
  };
  return {
    user_id: userId,
    mcp_server_id: serverId,
    oauth_access_token: open(row.oauth_access_token, 'access-token', 'access')!,
    oauth_token_expires_at: row.oauth_token_expires_at
      ? new Date(row.oauth_token_expires_at)
      : undefined,
    oauth_refresh_token: open(row.oauth_refresh_token, 'refresh-token', 'refresh'),
    oauth_client_id: open(row.oauth_client_id, 'client-id', 'client-id'),
    oauth_client_secret: open(row.oauth_client_secret, 'client-secret', 'client-secret'),
    grant_generation: generation,
    grant_binding_version:
      raw.grant_binding_version == null ? undefined : Number(raw.grant_binding_version),
    grant_binding_fingerprint: raw.grant_binding_fingerprint
      ? String(raw.grant_binding_fingerprint)
      : undefined,
    oauth_metadata_uri: raw.oauth_metadata_uri ? String(raw.oauth_metadata_uri) : undefined,
    oauth_resource_uri: raw.oauth_resource_uri ? String(raw.oauth_resource_uri) : undefined,
    oauth_issuer: raw.oauth_issuer ? String(raw.oauth_issuer) : undefined,
    oauth_authorization_endpoint: raw.oauth_authorization_endpoint
      ? String(raw.oauth_authorization_endpoint)
      : undefined,
    oauth_token_endpoint: raw.oauth_token_endpoint ? String(raw.oauth_token_endpoint) : undefined,
    oauth_redirect_uri: raw.oauth_redirect_uri ? String(raw.oauth_redirect_uri) : undefined,
    refresh_status: (raw.refresh_status ?? 'idle') as UserMCPOAuthToken['refresh_status'],
    refresh_generation: Number(raw.refresh_generation ?? 0),
    refresh_success_generation: Number(raw.refresh_success_generation ?? 0),
    refresh_claim_id: raw.refresh_claim_id ? String(raw.refresh_claim_id) : undefined,
    refresh_claimed_at: raw.refresh_claimed_at
      ? new Date(raw.refresh_claimed_at as string | number | Date)
      : undefined,
    created_at: new Date(row.created_at),
    updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
  };
}

/** Match either a per-user row (user_id = X) or the shared row (user_id IS NULL). */
function matchKey(userId: UserID | null, serverId: MCPServerID) {
  return and(
    userId === null ? isNull(userMcpOauthTokens.user_id) : eq(userMcpOauthTokens.user_id, userId),
    eq(userMcpOauthTokens.mcp_server_id, serverId)
  );
}

export class UserMCPOAuthTokenRepository {
  private readonly postgres: boolean;
  private readonly masterSecret?: string;

  constructor(
    private db: Database,
    masterSecret = process.env.AGOR_MASTER_SECRET
  ) {
    this.postgres = isPostgresDatabase(db);
    this.masterSecret = masterSecret;
    if (this.postgres && !masterSecret) {
      throw new RepositoryError('PostgreSQL MCP OAuth grants require AGOR_MASTER_SECRET');
    }
  }

  private tenantId(): string | undefined {
    const tenantId = getCurrentTenantId();
    if (this.postgres && !tenantId) {
      throw new RepositoryError('PostgreSQL MCP OAuth grant access requires tenant scope');
    }
    return tenantId;
  }

  private mapRow(row: UserMCPOAuthTokenRow): UserMCPOAuthToken {
    return rowToToken(row, {
      postgres: this.postgres,
      tenantId: this.tenantId(),
      masterSecret: this.masterSecret,
    });
  }

  /**
   * Look up the token row for a (user, server) pair. Pass `null` for userId
   * to read the shared-mode row.
   */
  async getToken(userId: UserID | null, serverId: MCPServerID): Promise<UserMCPOAuthToken | null> {
    try {
      const row = await select(this.db)
        .from(userMcpOauthTokens)
        .where(matchKey(userId, serverId))
        .one();

      return row ? this.mapRow(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to get OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Return the access token if it exists and is not expired. Does NOT refresh.
   *
   * Refresh is performed via `refreshAndPersistToken` in
   * `@agor/core/tools/mcp/oauth-refresh`, and is orchestrated by the daemon
   * service `mcp-servers/oauth-auth-headers` — which enforces the caller's
   * identity matches the token's `user_id` before exposing the header.
   */
  async getValidToken(userId: UserID | null, serverId: MCPServerID): Promise<string | undefined> {
    try {
      const token = await this.getToken(userId, serverId);

      if (!token) {
        return undefined;
      }

      if (token.oauth_token_expires_at && token.oauth_token_expires_at <= new Date()) {
        console.log(
          `[UserMCPOAuthToken] Token expired for user ${userId ?? '<shared>'}, server ${serverId}`
        );
        return undefined;
      }

      return token.oauth_access_token;
    } catch (error) {
      throw new RepositoryError(
        `Failed to get valid OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Save or update the token row. On update, undefined fields preserve their
   * existing value — important for refresh_token (providers may omit it if not
   * rotating) and client_id/client_secret (bound for the lifetime of the grant).
   */
  async saveToken(
    userId: UserID | null,
    serverId: MCPServerID,
    input: SaveTokenInput
  ): Promise<void> {
    try {
      const now = new Date();
      const tenantId = this.tenantId();
      // Three-state `expiresAt` flows straight onto Drizzle's `.set()`
      // semantics: `Date` writes, `null` writes NULL via conditional spread,
      // `undefined` preserves the existing value on update.
      //
      // The exact value here is what `resolveTokenExpiry` produced — no
      // buffer is applied at write time. Proactive-refresh buffering lives
      // in `needsRefresh` (REFRESH_BUFFER_MS) so we don't apply it twice.
      const expiresAtField: Date | null | undefined = input.expiresAt;

      if (this.postgres) {
        // Serialize check/insert/update per grant subject. This closes the
        // empty-row race while the generation predicate still ensures an
        // older callback can never replace a newer completed authorization.
        await executeRaw(
          this.db,
          sql`SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${[tenantId, userId ?? '<shared>', serverId].join('\u001f')},
              1
            )
          )`
        );
      }
      const existing = await this.getToken(userId, serverId);
      const binding = input.grantBinding;
      if (this.postgres && !binding) {
        throw new RepositoryError('PostgreSQL MCP OAuth grant save requires configuration binding');
      }
      if (binding && !input.clientId) {
        throw new RepositoryError('Bound MCP OAuth grant requires a client ID');
      }
      const generation = binding?.generation ?? existing?.grant_generation ?? 0;
      if (binding && (!Number.isSafeInteger(binding.generation) || binding.generation <= 0)) {
        throw new RepositoryError('MCP OAuth grant generation is invalid');
      }
      const seal = (
        value: string | undefined,
        purpose: 'access-token' | 'refresh-token' | 'client-id' | 'client-secret',
        field: string
      ): string | undefined => {
        if (value == null) return undefined;
        if (!this.postgres) return value;
        return sealMCPOAuthSecret(
          value,
          this.masterSecret!,
          purpose,
          grantSecretBinding(tenantId!, userId, serverId, generation, field)
        );
      };
      const sealedAccessToken = seal(input.accessToken, 'access-token', 'access')!;

      if (existing) {
        const result = await update(this.db, userMcpOauthTokens)
          .set({
            oauth_access_token: sealedAccessToken,
            // Spread so `undefined` ⇒ omit field (preserve), but `null` ⇒ write NULL.
            ...(expiresAtField !== undefined ? { oauth_token_expires_at: expiresAtField } : {}),
            ...(binding
              ? {
                  oauth_refresh_token: seal(input.refreshToken, 'refresh-token', 'refresh') ?? null,
                  oauth_client_id: seal(input.clientId, 'client-id', 'client-id') ?? null,
                  oauth_client_secret:
                    seal(input.clientSecret, 'client-secret', 'client-secret') ?? null,
                }
              : {
                  ...(input.refreshToken != null
                    ? {
                        oauth_refresh_token: seal(input.refreshToken, 'refresh-token', 'refresh'),
                      }
                    : {}),
                  ...(input.clientId != null
                    ? { oauth_client_id: seal(input.clientId, 'client-id', 'client-id') }
                    : {}),
                  ...(input.clientSecret != null
                    ? {
                        oauth_client_secret: seal(
                          input.clientSecret,
                          'client-secret',
                          'client-secret'
                        ),
                      }
                    : {}),
                }),
            ...(binding
              ? {
                  grant_generation: binding.generation,
                  grant_binding_version: binding.version,
                  grant_binding_fingerprint: binding.fingerprint,
                  oauth_metadata_uri: binding.metadataUri,
                  oauth_resource_uri: binding.resourceUri,
                  oauth_issuer: binding.issuer,
                  oauth_authorization_endpoint: binding.authorizationEndpoint,
                  oauth_token_endpoint: binding.tokenEndpoint,
                  oauth_redirect_uri: binding.redirectUri,
                  refresh_status: 'idle',
                  refresh_generation: 0,
                  refresh_success_generation: 0,
                  refresh_claim_id: null,
                  refresh_claimed_at: null,
                }
              : {}),
            updated_at: now,
          })
          .where(
            binding
              ? and(
                  matchKey(userId, serverId),
                  sql`${userMcpOauthTokens.grant_generation} <= ${binding.generation}`
                )
              : matchKey(userId, serverId)
          )
          .run();
        if (binding && result.rowsAffected !== 1) {
          throw new RepositoryError('A newer MCP OAuth grant superseded this attempt');
        }
        console.log('[MCP OAuth Grant] grant_saved category=replacement');
      } else {
        const newToken: UserMCPOAuthTokenInsert = {
          user_id: userId,
          mcp_server_id: serverId,
          oauth_access_token: sealedAccessToken,
          // On insert, `null` and `undefined` both write a missing column
          // (Drizzle treats `undefined` on insert as "use default", which for
          // a nullable column is NULL). Coerce to `undefined` to keep the
          // insert payload uniform regardless of which the caller passed.
          oauth_token_expires_at: expiresAtField ?? undefined,
          oauth_refresh_token: seal(input.refreshToken, 'refresh-token', 'refresh'),
          oauth_client_id: seal(input.clientId, 'client-id', 'client-id'),
          oauth_client_secret: seal(input.clientSecret, 'client-secret', 'client-secret'),
          grant_generation: generation,
          grant_binding_version: binding?.version,
          grant_binding_fingerprint: binding?.fingerprint,
          oauth_metadata_uri: binding?.metadataUri,
          oauth_resource_uri: binding?.resourceUri,
          oauth_issuer: binding?.issuer,
          oauth_authorization_endpoint: binding?.authorizationEndpoint,
          oauth_token_endpoint: binding?.tokenEndpoint,
          oauth_redirect_uri: binding?.redirectUri,
          refresh_status: 'idle',
          refresh_generation: 0,
          refresh_success_generation: 0,
          ...(tenantId ? { tenant_id: tenantId } : {}),
          created_at: now,
        };

        await insert(this.db, userMcpOauthTokens).values(newToken).run();

        console.log('[MCP OAuth Grant] grant_saved category=new');
      }
    } catch (error) {
      throw new RepositoryError(
        `Failed to save OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * PostgreSQL database-time refresh claim. A stale owner is not replayed:
   * the row becomes ambiguous because a rotating refresh token may have been
   * consumed before the owner died.
   */
  async claimRefresh(
    userId: UserID | null,
    serverId: MCPServerID,
    expected: MCPOAuthRefreshVersion
  ): Promise<MCPOAuthRefreshClaimResult> {
    if (!this.postgres) {
      return { outcome: 'observed', token: await this.getToken(userId, serverId) };
    }
    const claimId = randomUUID();
    const userPredicate = userId === null ? sql`user_id IS NULL` : sql`user_id = ${userId}`;
    try {
      await executeRaw(
        this.db,
        sql`
          UPDATE ${userMcpOauthTokens}
          SET refresh_status = 'ambiguous',
              refresh_claim_id = NULL,
              refresh_claimed_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE mcp_server_id = ${serverId}
            AND ${userPredicate}
            AND refresh_status = 'refreshing'
            AND refresh_claimed_at <= CURRENT_TIMESTAMP - INTERVAL '2 minutes'
        `
      );
      const claimed = await executeRaw(
        this.db,
        sql`
          UPDATE ${userMcpOauthTokens}
          SET refresh_status = 'refreshing',
              refresh_generation = refresh_generation + 1,
              refresh_claim_id = ${claimId},
              refresh_claimed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE mcp_server_id = ${serverId}
            AND ${userPredicate}
            AND grant_generation = ${expected.grantGeneration}
            AND refresh_generation = ${expected.refreshGeneration}
            AND refresh_status = 'idle'
            AND oauth_refresh_token IS NOT NULL
          RETURNING *
        `
      );
      const row = rowsOf(claimed)[0];
      if (!row) return { outcome: 'observed', token: await this.getToken(userId, serverId) };
      const token = this.mapRow(row as unknown as UserMCPOAuthTokenRow);
      return {
        outcome: 'claimed',
        token,
        claimId,
        refreshGeneration: token.refresh_generation,
        grantGeneration: token.grant_generation,
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError('Failed to claim MCP OAuth refresh', error);
    }
  }

  /** Commit token rotation only if this exact refresh/grant fence still owns the row. */
  async completeClaimedRefresh(
    userId: UserID | null,
    serverId: MCPServerID,
    claim: { claimId: string; refreshGeneration: number; grantGeneration: number },
    input: { accessToken: string; refreshToken?: string; expiresAt: Date | null }
  ): Promise<boolean> {
    if (!this.postgres) throw new RepositoryError('Durable refresh completion requires PostgreSQL');
    const tenantId = this.tenantId()!;
    const userPredicate = userId === null ? sql`user_id IS NULL` : sql`user_id = ${userId}`;
    const sealedAccess = sealMCPOAuthSecret(
      input.accessToken,
      this.masterSecret!,
      'access-token',
      grantSecretBinding(tenantId, userId, serverId, claim.grantGeneration, 'access')
    );
    const refreshAssignment = input.refreshToken
      ? sql`, oauth_refresh_token = ${sealMCPOAuthSecret(
          input.refreshToken,
          this.masterSecret!,
          'refresh-token',
          grantSecretBinding(tenantId, userId, serverId, claim.grantGeneration, 'refresh')
        )}`
      : sql``;
    const expiresAt = input.expiresAt?.toISOString() ?? null;
    const result = await executeRaw(
      this.db,
      sql`
        UPDATE ${userMcpOauthTokens}
        SET oauth_access_token = ${sealedAccess},
            oauth_token_expires_at = ${expiresAt},
            refresh_status = 'idle',
            refresh_success_generation = ${claim.refreshGeneration},
            refresh_claim_id = NULL,
            refresh_claimed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
            ${refreshAssignment}
        WHERE mcp_server_id = ${serverId}
          AND ${userPredicate}
          AND grant_generation = ${claim.grantGeneration}
          AND refresh_generation = ${claim.refreshGeneration}
          AND refresh_claim_id = ${claim.claimId}
          AND refresh_status = 'refreshing'
        RETURNING mcp_server_id
      `
    );
    return rowsOf(result).length === 1;
  }

  /** A losing invalid_grant can delete only the exact refresh/grant generation it used. */
  async deleteClaimedInvalidGrant(
    userId: UserID | null,
    serverId: MCPServerID,
    claim: { claimId: string; refreshGeneration: number; grantGeneration: number }
  ): Promise<boolean> {
    const userPredicate = userId === null ? sql`user_id IS NULL` : sql`user_id = ${userId}`;
    const result = await executeRaw(
      this.db,
      sql`
        DELETE FROM ${userMcpOauthTokens}
        WHERE mcp_server_id = ${serverId}
          AND ${userPredicate}
          AND grant_generation = ${claim.grantGeneration}
          AND refresh_generation = ${claim.refreshGeneration}
          AND refresh_claim_id = ${claim.claimId}
          AND refresh_status = 'refreshing'
        RETURNING mcp_server_id
      `
    );
    return rowsOf(result).length === 1;
  }

  async finishRefreshClaim(
    userId: UserID | null,
    serverId: MCPServerID,
    claim: { claimId: string; refreshGeneration: number; grantGeneration: number },
    outcome: 'idle' | 'ambiguous'
  ): Promise<boolean> {
    const userPredicate = userId === null ? sql`user_id IS NULL` : sql`user_id = ${userId}`;
    const result = await executeRaw(
      this.db,
      sql`
        UPDATE ${userMcpOauthTokens}
        SET refresh_status = ${outcome},
            refresh_claim_id = NULL,
            refresh_claimed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE mcp_server_id = ${serverId}
          AND ${userPredicate}
          AND grant_generation = ${claim.grantGeneration}
          AND refresh_generation = ${claim.refreshGeneration}
          AND refresh_claim_id = ${claim.claimId}
          AND refresh_status = 'refreshing'
        RETURNING mcp_server_id
      `
    );
    return rowsOf(result).length === 1;
  }

  /**
   * Delete a specific token row. Used on `invalid_grant` responses and from
   * the OAuth-disconnect service.
   */
  async deleteToken(userId: UserID | null, serverId: MCPServerID): Promise<boolean> {
    try {
      const result = await deleteFrom(this.db, userMcpOauthTokens)
        .where(matchKey(userId, serverId))
        .run();

      return result.rowsAffected > 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to delete OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Delete only the exact grant/config generation that a caller inspected. */
  async deleteGrantVersion(
    userId: UserID | null,
    serverId: MCPServerID,
    grantGeneration: number,
    grantBindingFingerprint?: string
  ): Promise<boolean> {
    try {
      const fingerprint = grantBindingFingerprint ?? null;
      const result = await deleteFrom(this.db, userMcpOauthTokens)
        .where(
          and(
            matchKey(userId, serverId),
            eq(userMcpOauthTokens.grant_generation, grantGeneration),
            sql`${userMcpOauthTokens.grant_binding_fingerprint} IS NOT DISTINCT FROM ${fingerprint}`
          )
        )
        .run();
      return result.rowsAffected > 0;
    } catch (error) {
      throw new RepositoryError('Failed to delete exact MCP OAuth grant version', error);
    }
  }

  async deleteAllForUser(userId: UserID): Promise<number> {
    try {
      const result = await deleteFrom(this.db, userMcpOauthTokens)
        .where(eq(userMcpOauthTokens.user_id, userId))
        .run();

      return result.rowsAffected;
    } catch (error) {
      throw new RepositoryError(
        `Failed to delete all OAuth tokens for user: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async deleteAllForServer(serverId: MCPServerID): Promise<number> {
    try {
      const result = await deleteFrom(this.db, userMcpOauthTokens)
        .where(eq(userMcpOauthTokens.mcp_server_id, serverId))
        .run();

      return result.rowsAffected;
    } catch (error) {
      throw new RepositoryError(
        `Failed to delete all OAuth tokens for server: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async listForUser(userId: UserID): Promise<UserMCPOAuthToken[]> {
    try {
      const rows = await select(this.db)
        .from(userMcpOauthTokens)
        .where(eq(userMcpOauthTokens.user_id, userId))
        .all();

      return rows.map((row: UserMCPOAuthTokenRow) => this.mapRow(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list OAuth tokens for user: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** List tenant-visible shared grants (`user_id IS NULL`). */
  async listShared(): Promise<UserMCPOAuthToken[]> {
    try {
      const rows = await select(this.db)
        .from(userMcpOauthTokens)
        .where(isNull(userMcpOauthTokens.user_id))
        .all();

      return rows.map((row: UserMCPOAuthTokenRow) => this.mapRow(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list shared OAuth tokens: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async hasValidToken(userId: UserID | null, serverId: MCPServerID): Promise<boolean> {
    const token = await this.getValidToken(userId, serverId);
    return token !== undefined;
  }
}
