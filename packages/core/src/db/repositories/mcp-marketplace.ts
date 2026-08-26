/**
 * Secret-free Marketplace overview projection.
 *
 * The MCP server configuration lives in one JSON column that also carries
 * credentials. Selecting that column and redacting it afterwards would make a
 * future missed field a credential disclosure. Every JSON value below is
 * therefore extracted in SQL by name; the secret-bearing object is never part
 * of a JavaScript result.
 */

import type {
  MCPMarketplaceAttachment,
  MCPMarketplaceCredential,
  MCPMarketplaceOverview,
  MCPMarketplaceServer,
  MCPMarketplaceTool,
  MCPServerID,
  MCPSource,
  SessionID,
  SessionStatus,
  ToolPermission,
  UserID,
} from '@agor/core/types';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { jsonExtract, select } from '../database-wrapper';
import { branches, mcpServers, sessionMcpServers, sessions, userMcpOauthTokens } from '../schema';
import { RepositoryError } from './base';
import { visibleSessionReferenceAccessExists } from './branch-access';

type SafeServerRow = {
  mcp_server_id: string;
  name: string;
  transport: MCPMarketplaceServer['transport'];
  enabled: unknown;
  source: MCPSource;
  catalog_entry_name: string | null;
  created_at: Date | string | number;
  updated_at: Date | string | number | null;
  display_name: unknown;
  description: unknown;
  tools_json: unknown;
  permissions_json: unknown;
  auth_type: unknown;
  credential_configured: unknown;
  credential_created_at: Date | string | number | null;
  credential_updated_at: Date | string | number | null;
  credential_expires_at: Date | string | number | null;
  credential_refresh_status: unknown;
};

type SafeAttachmentRow = {
  session_id: string;
  mcp_server_id: string;
  enabled: unknown;
  added_at: Date | string | number;
  session_title: unknown;
  session_status: SessionStatus;
  agentic_tool: MCPMarketplaceAttachment['agentic_tool'];
  branch_id: string;
  branch_name: string;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function iso(value: Date | string | number | null | undefined): string | undefined {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readPermissions(value: unknown): Record<string, ToolPermission> {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const permissions: Record<string, ToolPermission> = {};
  for (const [name, permission] of Object.entries(parsed)) {
    if (permission === 'allow' || permission === 'ask' || permission === 'deny') {
      permissions[name] = permission;
    }
  }
  return permissions;
}

function readTools(toolsValue: unknown, permissionsValue: unknown): MCPMarketplaceTool[] {
  const parsed = parseJson(toolsValue);
  if (!Array.isArray(parsed)) return [];
  const permissions = readPermissions(permissionsValue);
  const tools: MCPMarketplaceTool[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.length === 0) continue;
    tools.push({
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      permission: permissions[record.name] ?? 'default',
    });
  }
  return tools;
}

function credentialFrom(row: SafeServerRow, now: number): MCPMarketplaceCredential | undefined {
  const method = row.auth_type;
  if (method !== 'oauth' && method !== 'bearer' && method !== 'jwt') return undefined;

  if (method !== 'oauth') {
    return {
      mcp_server_id: row.mcp_server_id as MCPServerID,
      server_name: row.name,
      ...(stringValue(row.display_name)
        ? { server_display_name: stringValue(row.display_name) }
        : {}),
      method,
      status: row.credential_configured ? 'configured' : 'not_connected',
    };
  }

  const grantCreatedAt = iso(row.credential_created_at);
  const grantUpdatedAt = iso(row.credential_updated_at);
  const expiresAt = iso(row.credential_expires_at);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : undefined;
  const status = !grantCreatedAt
    ? 'not_connected'
    : row.credential_refresh_status !== 'idle'
      ? 'attention'
      : expiresAtMs !== undefined && expiresAtMs <= now
        ? 'expired'
        : 'active';

  return {
    mcp_server_id: row.mcp_server_id as MCPServerID,
    server_name: row.name,
    ...(stringValue(row.display_name)
      ? { server_display_name: stringValue(row.display_name) }
      : {}),
    method,
    status,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(grantCreatedAt ? { created_at: grantCreatedAt } : {}),
    ...(grantUpdatedAt ? { updated_at: grantUpdatedAt } : {}),
  };
}

export class MCPMarketplaceRepository {
  constructor(private readonly db: Database) {}

  async overviewForUser(userId: UserID, now = Date.now()): Promise<MCPMarketplaceOverview> {
    try {
      const displayName = jsonExtract(this.db, mcpServers.data, 'display_name');
      const description = jsonExtract(this.db, mcpServers.data, 'description');
      const tools = jsonExtract(this.db, mcpServers.data, 'tools');
      const permissions = jsonExtract(this.db, mcpServers.data, 'tool_permissions');
      const authType = jsonExtract(this.db, mcpServers.data, 'auth.type');
      // Boolean presence only: SQL evaluates the secret-bearing fields but
      // their values never enter a row returned to JavaScript.
      const credentialConfigured = sql<boolean>`case
        when ${authType} = 'bearer' then ${jsonExtract(this.db, mcpServers.data, 'auth.token')} is not null
        when ${authType} = 'jwt' then ${jsonExtract(this.db, mcpServers.data, 'auth.jwt_config.api_secret')} is not null
        else false
      end`;
      const sessionTitle = jsonExtract(this.db, sessions.data, 'title');

      const serverRows = (await select(this.db, {
        mcp_server_id: mcpServers.mcp_server_id,
        name: mcpServers.name,
        transport: mcpServers.transport,
        enabled: mcpServers.enabled,
        source: mcpServers.source,
        catalog_entry_name: mcpServers.catalog_entry_name,
        created_at: mcpServers.created_at,
        updated_at: mcpServers.updated_at,
        display_name: displayName,
        description,
        tools_json: tools,
        permissions_json: permissions,
        auth_type: authType,
        credential_configured: credentialConfigured,
        // OAuth metadata only. The access/refresh token, client registration,
        // binding, resource, issuer, and endpoint columns are intentionally
        // absent from this selection.
        credential_created_at: userMcpOauthTokens.created_at,
        credential_updated_at: userMcpOauthTokens.updated_at,
        credential_expires_at: userMcpOauthTokens.oauth_token_expires_at,
        credential_refresh_status: userMcpOauthTokens.refresh_status,
      })
        .from(mcpServers)
        .leftJoin(
          userMcpOauthTokens,
          and(
            eq(userMcpOauthTokens.mcp_server_id, mcpServers.mcp_server_id),
            eq(userMcpOauthTokens.user_id, userId)
          )
        )
        // Deliberately no admin exception and no ownerless row: Marketplace
        // personal inventory means the current caller's private rows.
        .where(eq(mcpServers.owner_user_id, userId))
        .orderBy(desc(mcpServers.updated_at), desc(mcpServers.created_at))
        .all()) as SafeServerRow[];

      const attachmentRows = (await select(this.db, {
        session_id: sessionMcpServers.session_id,
        mcp_server_id: sessionMcpServers.mcp_server_id,
        enabled: sessionMcpServers.enabled,
        added_at: sessionMcpServers.added_at,
        session_title: sessionTitle,
        session_status: sessions.status,
        agentic_tool: sessions.agentic_tool,
        branch_id: branches.branch_id,
        branch_name: branches.name,
      })
        .from(sessionMcpServers)
        .innerJoin(mcpServers, eq(mcpServers.mcp_server_id, sessionMcpServers.mcp_server_id))
        .innerJoin(sessions, eq(sessions.session_id, sessionMcpServers.session_id))
        .innerJoin(branches, eq(branches.branch_id, sessions.branch_id))
        .where(
          and(
            eq(mcpServers.owner_user_id, userId),
            // A private server is valid only in its owner's Session. Keep the
            // invariant at this read boundary too so pre-enforcement stale rows
            // cannot surface as somebody else's session metadata.
            eq(sessions.created_by, userId),
            visibleSessionReferenceAccessExists(this.db, userId, sessionMcpServers.session_id)
          )
        )
        .orderBy(desc(sessionMcpServers.added_at))
        .all()) as SafeAttachmentRow[];

      const attachments: MCPMarketplaceAttachment[] = attachmentRows.map((row) => ({
        session_id: row.session_id as SessionID,
        mcp_server_id: row.mcp_server_id as MCPServerID,
        enabled: Boolean(row.enabled),
        added_at: iso(row.added_at)!,
        ...(stringValue(row.session_title)
          ? { session_title: stringValue(row.session_title) }
          : {}),
        session_status: row.session_status,
        agentic_tool: row.agentic_tool,
        branch_id: row.branch_id,
        branch_name: row.branch_name,
      }));

      const countByServer = new Map<string, number>();
      for (const attachment of attachments) {
        countByServer.set(
          attachment.mcp_server_id,
          (countByServer.get(attachment.mcp_server_id) ?? 0) + 1
        );
      }

      const servers: MCPMarketplaceServer[] = serverRows.map((row) => {
        const createdAt = iso(row.created_at)!;
        return {
          mcp_server_id: row.mcp_server_id as MCPServerID,
          name: row.name,
          transport: row.transport,
          ...(stringValue(row.display_name) ? { display_name: stringValue(row.display_name) } : {}),
          ...(stringValue(row.description) ? { description: stringValue(row.description) } : {}),
          source: row.source,
          ...(row.catalog_entry_name ? { catalog_entry_name: row.catalog_entry_name } : {}),
          enabled: Boolean(row.enabled),
          tools: readTools(row.tools_json, row.permissions_json),
          session_count: countByServer.get(row.mcp_server_id) ?? 0,
          created_at: createdAt,
          updated_at: iso(row.updated_at) ?? createdAt,
        };
      });

      const credentials = serverRows
        .map((row) => credentialFrom(row, now))
        .filter((item): item is MCPMarketplaceCredential => item !== undefined);

      return {
        servers,
        attachments,
        credentials,
        generated_at: new Date(now).toISOString(),
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to load MCP Marketplace overview: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
  }
}
