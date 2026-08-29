/**
 * MCP Server Scoping Utility
 *
 * Shared logic for determining which MCP servers should be attached to a session.
 * Used by agentic-tool runtime adapters to ensure consistent behavior.
 *
 * Scoping Rules:
 * - ALL shared global-scoped MCPs are included in every session
 * - PLUS any session-scoped MCPs that are explicitly assigned to this session
 * - MINUS any server private to a user other than the current prompt actor
 *
 * Template Resolution:
 * MCP server env vars can contain Handlebars templates like {{ user.env.GITHUB_TOKEN }}.
 * Templates are resolved using process.env, which contains the user's decrypted
 * environment variables (populated by createUserProcessEnvironment when spawning).
 *
 * The repository layer filters both global rows and session assignments by the
 * current prompt actor. A shared prompt must never silently borrow the Session
 * owner's Agor-managed connectors or credentials.
 */

import { resolveMCPAuthHeaders } from '../tools/mcp/jwt-auth';
import type { MCPServer, MCPServerFilters, MCPServerID, SessionID } from '../types';
import { isMCPServerUsableBy } from './ownership';
import {
  buildMCPTemplateContextFromEnv,
  hasTemplateMarker,
  resolveMcpServerTemplates,
  TEMPLATE_RESOLVABLE_MCP_AUTH_SECRET_FIELDS,
} from './template-resolver';
import {
  canEnforceMcpToolPermissions,
  type HandlerPermissionCapabilities,
} from './tool-permissions';

export interface MCPScopingServerRepository {
  findAll(filters?: MCPServerFilters): Promise<MCPServer[]>;
}

export interface MCPScopingSessionRepository {
  listServers(sessionId: SessionID, enabledOnly?: boolean): Promise<MCPServer[]>;
  listEffectiveServers?(
    sessionId: SessionID,
    enabledOnly?: boolean,
    forUserId?: string
  ): Promise<MCPServer[]>;
}

export interface MCPAuthHeadersRepository {
  getAuthHeaders(
    mcpServerIds: MCPServerID[]
  ): Promise<Record<string, { authorization?: string; error?: string }>>;
}

const DEBUG_MCP_SCOPING =
  process.env.AGOR_DEBUG_MCP_SCOPING === '1' || process.env.DEBUG?.includes('mcp-scoping');

function mcpDebug(...args: unknown[]): void {
  if (DEBUG_MCP_SCOPING) {
    console.debug(...args);
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * MCP server with source metadata
 */
export interface MCPServerWithSource {
  server: MCPServer;
  source: 'session-assigned' | 'global';
  /** Non-persisted result from the tenant/user-scoped executor credential authority. */
  oauthAuthResolution: MCPOAuthAuthResolution;
}

export type MCPOAuthAuthResolution =
  | 'not_applicable'
  | 'not_attempted'
  | 'available'
  | 'unavailable'
  | 'error';

export class MCPOAuthAuthorityUnavailableError extends Error {
  constructor() {
    super('OAuth credential authority unavailable');
    this.name = 'MCPOAuthAuthorityUnavailableError';
  }
}

/** Resolve adapter headers while preserving the explicit credential-authority boundary. */
export function resolveScopedMCPAuthHeaders(
  scoped: MCPServerWithSource,
  options: { surfaceAuthorityError?: boolean } = {}
): Promise<Record<string, string> | undefined> {
  if (scoped.oauthAuthResolution === 'error' && options.surfaceAuthorityError) {
    return Promise.reject(new MCPOAuthAuthorityUnavailableError());
  }
  return resolveMCPAuthHeaders(scoped.server.auth, scoped.server.url, {
    oauthCredentialAuthority:
      scoped.oauthAuthResolution === 'not_attempted' ||
      scoped.oauthAuthResolution === 'not_applicable'
        ? 'configuration'
        : 'executor_repository',
  });
}

/**
 * Dependencies required for MCP server resolution
 */
export interface MCPResolutionDeps {
  sessionMCPRepo?: MCPScopingSessionRepository;
  mcpServerRepo?: MCPScopingServerRepository;
  /**
   * Trusted executor-only route for hydrating OAuth Authorization headers.
   *
   * Normal session MCP server payloads redact OAuth access tokens, so executor
   * paths must not rely on `server.auth.oauth_access_token` being present.
   */
  mcpOAuthAuthHeadersRepo?: MCPAuthHeadersRepository;
  /**
   * User ID to use for fetching per-user OAuth tokens.
   * When provided, MCP servers with per-user OAuth will have tokens injected.
   */
  forUserId?: string;
  /**
   * Told about each server the caller may not attach. An executor log is not a
   * channel an operator reads, and a server vanishing without explanation is
   * indistinguishable from it being broken.
   */
  onServerWithheld?: (server: MCPServer, reason: string) => void;
}

/**
 * Config key the built-in Agor MCP server is installed under. Reserved: it
 * carries the session's daemon bearer token and is auto-approved by name, so a
 * user-configured server must never be able to claim it.
 */
export const AGOR_MCP_SERVER_NAME = 'agor';

/**
 * Get MCP servers that should be attached to a session
 *
 * @param sessionId - Session to get servers for
 * @param deps - Repository dependencies
 * @returns Array of MCP servers with source metadata
 *
 * @example
 * ```typescript
 * const servers = await getMcpServersForSession(sessionId, {
 *   sessionMCPRepo,
 *   mcpServerRepo
 * });
 *
 * // Always returns: ALL global MCPs + session-assigned MCPs (deduplicated)
 * // => [
 * //   { server: { name: "filesystem", scope: "global", ... }, source: "global" },
 * //   { server: { name: "preset sdx", scope: "session", ... }, source: "session-assigned" }
 * // ]
 * ```
 */
export async function getMcpServersForSession(
  sessionId: SessionID,
  deps: MCPResolutionDeps,
  caps: HandlerPermissionCapabilities
): Promise<MCPServerWithSource[]> {
  const servers: MCPServerWithSource[] = [];

  // Early return if dependencies not available
  if (!deps.sessionMCPRepo || !deps.mcpServerRepo) {
    console.warn('⚠️  MCP repository dependencies not available - skipping MCP configuration');
    return servers;
  }

  try {
    mcpDebug('🔌 Resolving MCP servers for session...');
    mcpDebug(`   [MCP Scoping] forUserId: ${deps.forUserId || 'NOT SET'}`);

    // Track seen server IDs to prevent duplicates
    const seenServerIds = new Set<string>();

    const addServer = (server: MCPServer, source: MCPServerWithSource['source']) => {
      if (server.owner_user_id && !deps.forUserId) {
        console.warn(
          `   ⚠️  Skipping private MCP server because prompt actor identity is missing: ${server.name}`
        );
      }
      if (!isMCPServerUsableBy(server, deps.forUserId)) {
        mcpDebug(`   🔒 Skipping private MCP server not owned by prompt actor: ${server.name}`);
        return;
      }
      if (!seenServerIds.has(server.mcp_server_id)) {
        seenServerIds.add(server.mcp_server_id);
        servers.push({
          server,
          source,
          oauthAuthResolution: server.auth?.type === 'oauth' ? 'not_attempted' : 'not_applicable',
        });
        return;
      }

      console.warn(
        `   ⚠️  Skipping duplicate ${source} MCP server: ${server.name} (${server.mcp_server_id})`
      );
    };

    if (typeof deps.sessionMCPRepo.listEffectiveServers === 'function') {
      const effectiveServers = await deps.sessionMCPRepo.listEffectiveServers(
        sessionId,
        true,
        deps.forUserId
      );
      mcpDebug(`   📍 Effective session scope: ${effectiveServers.length} server(s)`);

      for (const server of effectiveServers) {
        addServer(server, server.scope === 'global' ? 'global' : 'session-assigned');
      }
    } else {
      // STEP 1: Get all usable global definitions for the prompt actor. OAuth
      // credentials are hydrated later through the executor-only auth-header
      // capability. A shared prompt must never import the session owner's
      // private MCP definitions or credentials.
      const globalServers = await deps.mcpServerRepo.findAll({
        scope: 'global',
        enabled: true,
        ...(deps.forUserId ? { usableByUserId: deps.forUserId } : {}),
      });

      mcpDebug(`   📍 Global scope: ${globalServers?.length ?? 0} server(s)`);

      for (const server of globalServers ?? []) {
        addServer(server, 'global');
      }

      // STEP 2: Get session-scoped MCP servers assigned to this specific session
      const sessionServers = await deps.sessionMCPRepo.listServers(sessionId, true); // enabledOnly

      mcpDebug(`   📍 Session-assigned: ${sessionServers.length} server(s)`);

      for (const server of sessionServers) {
        addServer(server, 'session-assigned');
      }
    }

    // Log summary (before template resolution)
    if (servers.length > 0) {
      mcpDebug(`   ✅ Total: ${servers.length} MCP server(s) resolved`);
      for (const { server, source } of servers) {
        mcpDebug(`      - ${server.name} (${server.transport}) [${source}]`);
      }
    } else {
      mcpDebug('   ℹ️  No MCP servers available for this session');
    }

    // STEP 3: Resolve templates in config fields (url, env.*, auth.*)
    // process.env contains user's decrypted env vars (set by createUserProcessEnvironment)
    // SECURITY: Only user-defined vars are exposed (via AGOR_USER_ENV_KEYS)
    const templateContext = buildMCPTemplateContextFromEnv(process.env);
    let templatesResolved = 0;
    let serversSkipped = 0;

    // Every auth field `resolveMcpServerTemplates` substitutes. Driven from the
    // canonical secret set plus the non-secret auth templates the resolver also
    // handles, so this trigger cannot drift from what resolution resolves.
    const AUTH_TEMPLATE_FIELDS = [
      ...TEMPLATE_RESOLVABLE_MCP_AUTH_SECRET_FIELDS,
      'api_url',
      'oauth_authorization_url',
      'oauth_token_url',
      'oauth_client_id',
      'oauth_scope',
    ] as const;

    // Process servers in reverse to safely remove invalid ones
    for (let i = servers.length - 1; i >= 0; i--) {
      const original = servers[i].server;

      // Check if any templatable field contains templates
      const envValues = Object.values(original.env ?? {}) as string[];
      const headerValues = Object.values(original.headers ?? {}) as string[];
      const hasEnvTemplates = envValues.some(hasTemplateMarker);
      const hasHeaderTemplates = headerValues.some(hasTemplateMarker);
      const hasUrlTemplate = hasTemplateMarker(original.url);
      const hasAuthTemplates = AUTH_TEMPLATE_FIELDS.some((field) =>
        hasTemplateMarker(original.auth?.[field] as string | undefined)
      );

      // Resolve and validate every server, even when its stored row has no
      // templates. This is the last common boundary before executor SDK config
      // is built, and it prevents malformed legacy rows from being dispatched.
      {
        const hasTemplates =
          hasEnvTemplates || hasHeaderTemplates || hasUrlTemplate || hasAuthTemplates;
        const result = resolveMcpServerTemplates(original, templateContext);

        if (!result.isValid) {
          // Remove server from list - required templates didn't resolve
          console.warn(
            `[mcp-template] server_withheld server_id=${original.mcp_server_id} reason=invalid_configuration`
          );
          servers.splice(i, 1);
          serversSkipped++;
        } else {
          servers[i] = {
            ...servers[i],
            server: result.server,
          };
          if (hasTemplates) templatesResolved++;

          // Log warnings for non-critical unresolved fields
          if (result.unresolvedFields.length > 0) {
            console.warn(
              `[mcp-template] optional_fields_unresolved server_id=${original.mcp_server_id} fields=${result.unresolvedFields.join(',')}`
            );
          }
        }
      }
    }

    if (templatesResolved > 0) {
      mcpDebug(`   🔧 Resolved templates in ${templatesResolved} MCP server(s)`);
    }
    if (serversSkipped > 0) {
      console.warn(
        `   ⚠️  Skipped ${serversSkipped} MCP server(s) due to unresolved required templates`
      );
    }

    // Admission gate: a handler that cannot honour a server's `tool_permissions`
    // does not get the server. Refusing to attach is the only way to keep a
    // `deny` meaningful on a handler with no per-tool control — the alternative
    // is handing over the exact tools someone switched off.
    for (let i = servers.length - 1; i >= 0; i--) {
      const { server } = servers[i];
      if (canEnforceMcpToolPermissions(server, caps)) continue;

      servers.splice(i, 1);
      const reason =
        `it sets tool_permissions this agent cannot enforce (tool filtering: ` +
        `${caps.toolFiltering}). Attach it to an agent that can, or clear the deny/ask entries.`;
      console.warn(`   ⛔ Withholding MCP server "${server.name}": ${reason}`);
      deps.onServerWithheld?.(server, reason);
    }

    const oauthServers = servers
      .map(({ server }) => server)
      .filter((server) => server.auth?.type === 'oauth');
    if (oauthServers.length > 0) {
      if (!deps.mcpOAuthAuthHeadersRepo) {
        mcpDebug(
          `   ℹ️  ${oauthServers.length} OAuth MCP server(s) resolved without executor auth-header hydrator`
        );
      } else {
        for (const scoped of servers) {
          if (scoped.server.auth?.type === 'oauth') scoped.oauthAuthResolution = 'unavailable';
        }
        try {
          const authHeaders = await deps.mcpOAuthAuthHeadersRepo.getAuthHeaders(
            oauthServers.map((server) => server.mcp_server_id)
          );
          let hydrated = 0;
          for (let i = 0; i < servers.length; i++) {
            const server = servers[i].server;
            if (server.auth?.type !== 'oauth') continue;

            const header = authHeaders[server.mcp_server_id];
            const bearer = /^Bearer\s+(.+)$/i.exec(header?.authorization ?? '')?.[1];
            if (!bearer) {
              continue;
            }

            servers[i] = {
              ...servers[i],
              oauthAuthResolution: 'available',
              server: {
                ...server,
                auth: {
                  ...server.auth,
                  oauth_access_token: bearer,
                  // The scoped repository returned a currently usable bearer;
                  // a persisted expiry belongs to the configured token, not it.
                  oauth_token_expires_at: undefined,
                },
              },
            };
            hydrated++;
          }
          mcpDebug(`   🔐 Hydrated OAuth auth headers for ${hydrated} MCP server(s)`);
        } catch {
          for (const scoped of servers) {
            if (scoped.server.auth?.type === 'oauth') scoped.oauthAuthResolution = 'error';
          }
          console.warn('[mcp.auth] authority_unavailable authority=executor_repository');
        }
      }
    }

    // Keep MCP config order stable across turns. Provider SDKs serialize MCP
    // tools into the prompt prefix, so DB/default ordering drift can reduce
    // server-side prompt-cache hits even when the effective server set is the
    // same. Global servers stay before session-assigned servers to preserve the
    // historical scoping precedence; names and IDs make the ordering total.
    servers.sort((a, b) => {
      const sourceRank = (source: MCPServerWithSource['source']) => (source === 'global' ? 0 : 1);
      return (
        sourceRank(a.source) - sourceRank(b.source) ||
        compareStrings(a.server.name, b.server.name) ||
        compareStrings(String(a.server.mcp_server_id), String(b.server.mcp_server_id))
      );
    });
  } catch {
    console.warn('[mcp-runtime] server_resolution_failed');
    // Return empty array on error to avoid breaking session creation
    return [];
  }

  return servers;
}
