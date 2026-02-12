/**
 * User MCP OAuth Token Repository
 *
 * Manages per-user OAuth 2.1 tokens for MCP servers.
 * Used when MCP servers are configured with oauth_mode: 'per_user'.
 */

import type { MCPServerID, UserID } from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  type UserMCPOAuthTokenInsert,
  type UserMCPOAuthTokenRow,
  userMcpOauthTokens,
} from '../schema';
import { RepositoryError } from './base';

/**
 * User MCP OAuth Token data structure
 */
export interface UserMCPOAuthToken {
  user_id: UserID;
  mcp_server_id: MCPServerID;
  oauth_access_token: string;
  oauth_token_expires_at?: Date;
  oauth_refresh_token?: string;
  created_at: Date;
  updated_at?: Date;
}

/**
 * User MCP OAuth Token repository implementation
 */
export class UserMCPOAuthTokenRepository {
  constructor(private db: Database) {}

  /**
   * Get OAuth token for a user and MCP server
   */
  async getToken(userId: UserID, serverId: MCPServerID): Promise<UserMCPOAuthToken | null> {
    try {
      const row = await select(this.db)
        .from(userMcpOauthTokens)
        .where(
          and(
            eq(userMcpOauthTokens.user_id, userId),
            eq(userMcpOauthTokens.mcp_server_id, serverId)
          )
        )
        .one();

      if (!row) {
        return null;
      }

      return {
        user_id: row.user_id as UserID,
        mcp_server_id: row.mcp_server_id as MCPServerID,
        oauth_access_token: row.oauth_access_token,
        oauth_token_expires_at: row.oauth_token_expires_at
          ? new Date(row.oauth_token_expires_at)
          : undefined,
        oauth_refresh_token: row.oauth_refresh_token || undefined,
        created_at: new Date(row.created_at),
        updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to get OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Get valid (non-expired) OAuth access token for a user and MCP server
   * Returns undefined if token doesn't exist or is expired
   */
  async getValidToken(userId: UserID, serverId: MCPServerID): Promise<string | undefined> {
    try {
      const token = await this.getToken(userId, serverId);

      if (!token) {
        return undefined;
      }

      // Check if token is expired
      if (token.oauth_token_expires_at && token.oauth_token_expires_at <= new Date()) {
        console.log(`[UserMCPOAuthToken] Token expired for user ${userId}, server ${serverId}`);
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
   * Save or update OAuth token for a user and MCP server
   */
  async saveToken(
    userId: UserID,
    serverId: MCPServerID,
    accessToken: string,
    expiresInSeconds?: number,
    refreshToken?: string
  ): Promise<void> {
    try {
      const now = new Date();
      const expiresAt = expiresInSeconds
        ? new Date(Date.now() + (expiresInSeconds - 60) * 1000) // 60s buffer
        : undefined;

      // Check if token already exists
      const existing = await this.getToken(userId, serverId);

      if (existing) {
        // Update existing token
        await update(this.db, userMcpOauthTokens)
          .set({
            oauth_access_token: accessToken,
            oauth_token_expires_at: expiresAt,
            oauth_refresh_token: refreshToken,
            updated_at: now,
          })
          .where(
            and(
              eq(userMcpOauthTokens.user_id, userId),
              eq(userMcpOauthTokens.mcp_server_id, serverId)
            )
          )
          .run();

        console.log(`[UserMCPOAuthToken] Updated token for user ${userId}, server ${serverId}`);
      } else {
        // Insert new token
        const newToken: UserMCPOAuthTokenInsert = {
          user_id: userId,
          mcp_server_id: serverId,
          oauth_access_token: accessToken,
          oauth_token_expires_at: expiresAt,
          oauth_refresh_token: refreshToken,
          created_at: now,
        };

        await insert(this.db, userMcpOauthTokens).values(newToken).run();

        console.log(`[UserMCPOAuthToken] Saved new token for user ${userId}, server ${serverId}`);
      }
    } catch (error) {
      throw new RepositoryError(
        `Failed to save OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete OAuth token for a user and MCP server
   */
  async deleteToken(userId: UserID, serverId: MCPServerID): Promise<boolean> {
    try {
      const result = await deleteFrom(this.db, userMcpOauthTokens)
        .where(
          and(
            eq(userMcpOauthTokens.user_id, userId),
            eq(userMcpOauthTokens.mcp_server_id, serverId)
          )
        )
        .run();

      return result.rowsAffected > 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to delete OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete all OAuth tokens for a user
   */
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

  /**
   * Delete all OAuth tokens for an MCP server
   */
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

  /**
   * List all OAuth tokens for a user
   */
  async listForUser(userId: UserID): Promise<UserMCPOAuthToken[]> {
    try {
      const rows = await select(this.db)
        .from(userMcpOauthTokens)
        .where(eq(userMcpOauthTokens.user_id, userId))
        .all();

      return rows.map((row: UserMCPOAuthTokenRow) => ({
        user_id: row.user_id as UserID,
        mcp_server_id: row.mcp_server_id as MCPServerID,
        oauth_access_token: row.oauth_access_token,
        oauth_token_expires_at: row.oauth_token_expires_at
          ? new Date(row.oauth_token_expires_at)
          : undefined,
        oauth_refresh_token: row.oauth_refresh_token || undefined,
        created_at: new Date(row.created_at),
        updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
      }));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list OAuth tokens for user: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Check if a user has a valid token for an MCP server
   */
  async hasValidToken(userId: UserID, serverId: MCPServerID): Promise<boolean> {
    const token = await this.getValidToken(userId, serverId);
    return token !== undefined;
  }
}
