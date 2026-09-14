import type {
  MCPAuth,
  MCPCatalogServerCandidate,
  MCPServer,
  MCPServerID,
  MCPSource,
  MCPTransport,
  UserID,
} from '@agor/core/types';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { MCP_HEADER_REDACTED_SENTINEL } from '../../tools/mcp/http-headers';
import type { Database } from '../client';
import { isPostgresDatabase, jsonExtract, select } from '../database-wrapper';
import { mcpServers, userMcpOauthTokens } from '../schema';
import { RepositoryError } from './base';

type CandidateRow = {
  mcp_server_id: string;
  name: string;
  enabled: unknown;
  transport: MCPTransport;
  scope: MCPServer['scope'];
  source: MCPSource;
  owner_user_id: string | null;
  catalog_entry_name: string | null;
  created_at: Date | string | number;
  updated_at: Date | string | number | null;
  display_name: unknown;
  description: unknown;
  url: unknown;
  tools: unknown;
  resources: unknown;
  prompts: unknown;
  tool_permissions: unknown;
  auth_type: unknown;
  oauth_mode: unknown;
  oauth_scope: unknown;
  oauth_client_id: unknown;
  oauth_dcr_mode: unknown;
  oauth_compatibility_mode: unknown;
  oauth_authorization_url: unknown;
  oauth_token_url: unknown;
  oauth_grant_type: unknown;
  insecure: unknown;
  has_headers: unknown;
  has_row_secret: unknown;
  has_oauth_client_secret: unknown;
  has_access_token: unknown;
  grant_expires_at: Date | string | number | null;
  refresh_status: unknown;
  resource_uri: string | null;
  grant_binding_version: unknown;
  has_grant_binding_fingerprint: unknown;
};

function parseJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function authFrom(row: CandidateRow): MCPAuth | undefined {
  const type = stringValue(row.auth_type);
  if (type === 'none') return { type: 'none' };
  if (type === 'bearer') {
    return {
      type: 'bearer',
      ...(row.has_row_secret ? { token: MCP_HEADER_REDACTED_SENTINEL } : {}),
    };
  }
  if (type !== 'oauth') return undefined;
  return {
    type: 'oauth',
    ...(stringValue(row.oauth_mode)
      ? { oauth_mode: stringValue(row.oauth_mode) as 'per_user' | 'shared' }
      : {}),
    ...(stringValue(row.oauth_scope) ? { oauth_scope: stringValue(row.oauth_scope) } : {}),
    ...(stringValue(row.oauth_client_id)
      ? { oauth_client_id: stringValue(row.oauth_client_id) }
      : {}),
    ...(stringValue(row.oauth_dcr_mode)
      ? {
          oauth_dcr_mode: stringValue(row.oauth_dcr_mode) as NonNullable<MCPAuth['oauth_dcr_mode']>,
        }
      : {}),
    ...(stringValue(row.oauth_compatibility_mode)
      ? {
          oauth_compatibility_mode: stringValue(row.oauth_compatibility_mode) as NonNullable<
            MCPAuth['oauth_compatibility_mode']
          >,
        }
      : {}),
    ...(stringValue(row.oauth_authorization_url)
      ? { oauth_authorization_url: stringValue(row.oauth_authorization_url) }
      : {}),
    ...(stringValue(row.oauth_token_url)
      ? { oauth_token_url: stringValue(row.oauth_token_url) }
      : {}),
    ...(stringValue(row.oauth_grant_type)
      ? {
          oauth_grant_type: stringValue(row.oauth_grant_type) as NonNullable<
            MCPAuth['oauth_grant_type']
          >,
        }
      : {}),
    ...(row.has_oauth_client_secret ? { oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL } : {}),
    ...(row.insecure ? { insecure: true } : {}),
  };
}

/** Secret-free candidate inventory for readiness and Connect selection. */
export class MCPCatalogCandidateRepository {
  constructor(private readonly db: Database) {}

  async listForUser(userId: UserID): Promise<MCPCatalogServerCandidate[]> {
    try {
      const authType = jsonExtract(this.db, mcpServers.data, 'auth.type');
      const headerJson = jsonExtract(this.db, mcpServers.data, 'headers');
      const hasHeaders = isPostgresDatabase(this.db)
        ? sql<boolean>`coalesce(${mcpServers.data}->'headers', '{}'::jsonb) <> '{}'::jsonb`
        : sql<boolean>`exists(select 1 from json_each(coalesce(${headerJson}, '{}')) limit 1)`;
      const hasRowSecret = sql<boolean>`case
        when ${authType} = 'bearer' then ${jsonExtract(this.db, mcpServers.data, 'auth.token')} is not null
        when ${authType} = 'jwt' then ${jsonExtract(this.db, mcpServers.data, 'auth.jwt_config.api_secret')} is not null
        when ${authType} = 'oauth' then
          ${jsonExtract(this.db, mcpServers.data, 'auth.oauth_client_secret')} is not null or
          ${jsonExtract(this.db, mcpServers.data, 'auth.oauth_access_token')} is not null or
          ${jsonExtract(this.db, mcpServers.data, 'auth.oauth_refresh_token')} is not null
        else false end`;
      const rows = (await select(this.db, {
        mcp_server_id: mcpServers.mcp_server_id,
        name: mcpServers.name,
        enabled: mcpServers.enabled,
        transport: mcpServers.transport,
        scope: mcpServers.scope,
        source: mcpServers.source,
        owner_user_id: mcpServers.owner_user_id,
        catalog_entry_name: mcpServers.catalog_entry_name,
        created_at: mcpServers.created_at,
        updated_at: mcpServers.updated_at,
        display_name: jsonExtract(this.db, mcpServers.data, 'display_name'),
        description: jsonExtract(this.db, mcpServers.data, 'description'),
        url: jsonExtract(this.db, mcpServers.data, 'url'),
        tools: jsonExtract(this.db, mcpServers.data, 'tools'),
        resources: jsonExtract(this.db, mcpServers.data, 'resources'),
        prompts: jsonExtract(this.db, mcpServers.data, 'prompts'),
        tool_permissions: jsonExtract(this.db, mcpServers.data, 'tool_permissions'),
        auth_type: authType,
        oauth_mode: jsonExtract(this.db, mcpServers.data, 'auth.oauth_mode'),
        oauth_scope: jsonExtract(this.db, mcpServers.data, 'auth.oauth_scope'),
        oauth_client_id: jsonExtract(this.db, mcpServers.data, 'auth.oauth_client_id'),
        oauth_dcr_mode: jsonExtract(this.db, mcpServers.data, 'auth.oauth_dcr_mode'),
        oauth_compatibility_mode: jsonExtract(
          this.db,
          mcpServers.data,
          'auth.oauth_compatibility_mode'
        ),
        oauth_authorization_url: jsonExtract(
          this.db,
          mcpServers.data,
          'auth.oauth_authorization_url'
        ),
        oauth_token_url: jsonExtract(this.db, mcpServers.data, 'auth.oauth_token_url'),
        oauth_grant_type: jsonExtract(this.db, mcpServers.data, 'auth.oauth_grant_type'),
        insecure: jsonExtract(this.db, mcpServers.data, 'auth.insecure'),
        has_headers: hasHeaders,
        has_row_secret: hasRowSecret,
        has_oauth_client_secret: sql<boolean>`${jsonExtract(this.db, mcpServers.data, 'auth.oauth_client_secret')} is not null`,
        has_access_token: sql<boolean>`${userMcpOauthTokens.oauth_access_token} is not null`,
        grant_expires_at: userMcpOauthTokens.oauth_token_expires_at,
        refresh_status: userMcpOauthTokens.refresh_status,
        resource_uri: userMcpOauthTokens.oauth_resource_uri,
        grant_binding_version: userMcpOauthTokens.grant_binding_version,
        has_grant_binding_fingerprint: sql<boolean>`${userMcpOauthTokens.grant_binding_fingerprint} is not null`,
      })
        .from(mcpServers)
        .leftJoin(
          userMcpOauthTokens,
          and(
            eq(userMcpOauthTokens.mcp_server_id, mcpServers.mcp_server_id),
            eq(userMcpOauthTokens.user_id, userId)
          )
        )
        .where(or(eq(mcpServers.owner_user_id, userId), isNull(mcpServers.owner_user_id)))
        .all()) as CandidateRow[];

      return rows.map((row) => {
        const server: MCPServer = {
          mcp_server_id: row.mcp_server_id as MCPServerID,
          name: row.name,
          ...(stringValue(row.display_name) ? { display_name: stringValue(row.display_name) } : {}),
          ...(stringValue(row.description) ? { description: stringValue(row.description) } : {}),
          transport: row.transport,
          scope: row.scope,
          source: row.source,
          enabled: Boolean(row.enabled),
          ...(row.owner_user_id ? { owner_user_id: row.owner_user_id as UserID } : {}),
          ...(row.catalog_entry_name ? { catalog_entry_name: row.catalog_entry_name } : {}),
          ...(stringValue(row.url) ? { url: stringValue(row.url) } : {}),
          headers: row.has_headers ? { __configured__: MCP_HEADER_REDACTED_SENTINEL } : {},
          ...(authFrom(row) ? { auth: authFrom(row) } : {}),
          ...(parseJson<MCPServer['tools']>(row.tools) ? { tools: parseJson(row.tools) } : {}),
          ...(parseJson<MCPServer['resources']>(row.resources)
            ? { resources: parseJson(row.resources) }
            : {}),
          ...(parseJson<MCPServer['prompts']>(row.prompts)
            ? { prompts: parseJson(row.prompts) }
            : {}),
          ...(parseJson<MCPServer['tool_permissions']>(row.tool_permissions)
            ? { tool_permissions: parseJson(row.tool_permissions) }
            : {}),
          created_at: new Date(row.created_at),
          updated_at: new Date(row.updated_at ?? row.created_at),
        };
        const expires = row.grant_expires_at ? new Date(row.grant_expires_at).getTime() : undefined;
        const bindingVersion =
          row.grant_binding_version == null ? undefined : Number(row.grant_binding_version);
        // PostgreSQL has always required a versioned HMAC. Standalone keeps
        // truly historical unbound rows usable. This projection deliberately
        // does not verify or select client-secret material: readiness is
        // advisory and Connect recomputes the full binding before reuse.
        const bindingReady =
          bindingVersion === undefined
            ? !isPostgresDatabase(this.db)
            : [1, 2, 3, 4].includes(bindingVersion) && Boolean(row.has_grant_binding_fingerprint);
        return {
          server,
          has_row_secret: Boolean(row.has_row_secret),
          ...(row.has_access_token ||
          row.resource_uri ||
          row.grant_expires_at ||
          row.grant_binding_version != null
            ? {
                grant: {
                  has_access_token: Boolean(row.has_access_token),
                  ...(expires !== undefined && !Number.isNaN(expires)
                    ? { expires_at: expires }
                    : {}),
                  refresh_status:
                    row.refresh_status === 'refreshing' || row.refresh_status === 'ambiguous'
                      ? row.refresh_status
                      : 'idle',
                  ...(row.resource_uri ? { resource_uri: row.resource_uri } : {}),
                  binding_ready: bindingReady,
                },
              }
            : {}),
        };
      });
    } catch (error) {
      throw new RepositoryError(
        `Failed to read MCP catalog candidates: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async getForUser(
    userId: UserID,
    serverId: MCPServerID
  ): Promise<MCPCatalogServerCandidate | undefined> {
    return (await this.listForUser(userId)).find(
      (candidate) => candidate.server.mcp_server_id === serverId
    );
  }
}
