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

import type { MCPServerID, UserID } from '@agor/core/types';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  type UserMCPOAuthTokenInsert,
  type UserMCPOAuthTokenRow,
  userMcpOauthTokens,
} from '../schema';
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
  created_at: Date;
  updated_at?: Date;
}

/** Input shape for `saveToken`. */
export interface SaveTokenInput {
  accessToken: string;
  /** Seconds until expiry, matching the OAuth token response. */
  expiresInSeconds?: number;
  /** If absent on update, the existing refresh_token is kept. */
  refreshToken?: string;
  /** If absent on update, the existing client_id is kept. */
  clientId?: string;
  /** If absent on update, the existing client_secret is kept. */
  clientSecret?: string;
}

function rowToToken(row: UserMCPOAuthTokenRow): UserMCPOAuthToken {
  return {
    user_id: (row.user_id as UserID | null) ?? null,
    mcp_server_id: row.mcp_server_id as MCPServerID,
    oauth_access_token: row.oauth_access_token,
    oauth_token_expires_at: row.oauth_token_expires_at
      ? new Date(row.oauth_token_expires_at)
      : undefined,
    oauth_refresh_token: row.oauth_refresh_token || undefined,
    oauth_client_id: row.oauth_client_id || undefined,
    oauth_client_secret: row.oauth_client_secret || undefined,
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
  constructor(private db: Database) {}

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

      return row ? rowToToken(row) : null;
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
      // Store the EXACT expiry the provider returned. The proactive-refresh
      // buffer lives in `needsRefresh` (REFRESH_BUFFER_MS) so we don't apply
      // it twice.
      const expiresAt = input.expiresInSeconds
        ? new Date(Date.now() + input.expiresInSeconds * 1000)
        : undefined;

      const existing = await this.getToken(userId, serverId);

      if (existing) {
        await update(this.db, userMcpOauthTokens)
          .set({
            oauth_access_token: input.accessToken,
            oauth_token_expires_at: expiresAt,
            ...(input.refreshToken != null ? { oauth_refresh_token: input.refreshToken } : {}),
            ...(input.clientId != null ? { oauth_client_id: input.clientId } : {}),
            ...(input.clientSecret != null ? { oauth_client_secret: input.clientSecret } : {}),
            updated_at: now,
          })
          .where(matchKey(userId, serverId))
          .run();

        console.log(
          `[UserMCPOAuthToken] Updated token for user ${userId ?? '<shared>'}, server ${serverId}`
        );
      } else {
        const newToken: UserMCPOAuthTokenInsert = {
          user_id: userId,
          mcp_server_id: serverId,
          oauth_access_token: input.accessToken,
          oauth_token_expires_at: expiresAt,
          oauth_refresh_token: input.refreshToken,
          oauth_client_id: input.clientId,
          oauth_client_secret: input.clientSecret,
          created_at: now,
        };

        await insert(this.db, userMcpOauthTokens).values(newToken).run();

        console.log(
          `[UserMCPOAuthToken] Saved new token for user ${userId ?? '<shared>'}, server ${serverId}`
        );
      }
    } catch (error) {
      throw new RepositoryError(
        `Failed to save OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
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

      return rows.map(rowToToken);
    } catch (error) {
      throw new RepositoryError(
        `Failed to list OAuth tokens for user: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async hasValidToken(userId: UserID | null, serverId: MCPServerID): Promise<boolean> {
    const token = await this.getValidToken(userId, serverId);
    return token !== undefined;
  }
}
