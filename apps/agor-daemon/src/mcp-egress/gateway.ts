import { createHmac, randomUUID } from 'node:crypto';
import {
  BranchRepository,
  decryptApiKey,
  GatewayChannelRepository,
  getMCPEgressGatewayMode,
  isEncrypted,
  MCPServerRepository,
  runWithTenantDatabaseTransaction,
  SessionMCPServerRepository,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { getConnector } from '@agor/core/gateway';
import {
  buildMCPTemplateContextFromEnv,
  extractMCPTemplateDependencies,
  isMCPServerUsableBy,
  resolveMcpServerTemplates,
} from '@agor/core/mcp';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import { fetchJWTToken, resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import { OAuthRefreshAuthorityCancelledError } from '@agor/core/tools/mcp/oauth-refresh';
import type {
  AuthenticatedParams,
  GatewayEnvVar,
  MCPServer,
  Session,
  SessionID,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES, TaskStatus } from '@agor/core/types';
import {
  type OutboundDnsLookup,
  OutboundPreDispatchAuthorityError,
  safeOutboundFetch,
} from '@agor/core/utils/safe-outbound-fetch';
import { getDaemonMetrics } from '../metrics/index.js';
import { resolveSessionPromptAccess } from '../utils/branch-authorization.js';
import { type MCPEgressCapabilityClaims, verifyMCPEgressCapability } from './capability.js';

const ACTIVE_TASK_STATES = new Set<import('@agor/core/types').TaskStatus>([
  TaskStatus.DISPATCHING,
  TaskStatus.RUNNING,
  TaskStatus.AWAITING_PERMISSION,
  TaskStatus.AWAITING_INPUT,
]);
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 30_000;
const SECRET_MIN_LENGTH = 8;
const MAX_PROCESS_IN_FLIGHT = 32;
const MAX_TENANT_IN_FLIGHT = 16;
const MAX_TASK_IN_FLIGHT = 4;
const MAX_SERVER_IN_FLIGHT = 8;

export type MCPEgressEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'transport_not_mediated' | 'approval_not_mediated' | 'template_configuration';
    };

/** Shared by executor projection and final admission; unsupported means omit/fail closed. */
export function mcpEgressEligibility(server: MCPServer): MCPEgressEligibility {
  if (server.transport !== 'http' || !server.url) {
    return { eligible: false, reason: 'transport_not_mediated' };
  }
  if (Object.values(server.tool_permissions ?? {}).includes('ask')) {
    return { eligible: false, reason: 'approval_not_mediated' };
  }
  if (!extractMCPTemplateDependencies(server).valid) {
    return { eligible: false, reason: 'template_configuration' };
  }
  return { eligible: true };
}

/** The only MCP server shape an executor may receive in a mediated mode. */
export function projectMCPServerForExecutor(
  server: MCPServer,
  gatewayUrl: string,
  capability: string
): MCPServer {
  const {
    command: _command,
    args: _args,
    env: _env,
    auth: _auth,
    headers: _headers,
    url: _url,
    ...safeMetadata
  } = server;
  return {
    ...safeMetadata,
    transport: 'http',
    url: gatewayUrl,
    headers: { 'X-Agor-Mcp-Capability': capability },
  };
}

export class MCPEgressGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'MCPEgressGatewayError';
  }
}

export type MCPEgressServerAbortReason = 'server_detached' | 'stale_capability';

function abortReasonError(reason: MCPEgressServerAbortReason | 'rollout_changed' | 'shutdown') {
  switch (reason) {
    case 'server_detached':
      return new MCPEgressGatewayError(403, 'server_detached', 'MCP server was detached');
    case 'stale_capability':
      return new MCPEgressGatewayError(
        409,
        'stale_capability',
        'MCP server configuration changed; reconnect this task'
      );
    case 'rollout_changed':
      return new MCPEgressGatewayError(
        409,
        'rollout_changed',
        'MCP gateway rollout changed; reconnect this task'
      );
    case 'shutdown':
      return new MCPEgressGatewayError(
        503,
        'egress_unavailable',
        'MCP gateway egress is temporarily unavailable'
      );
  }
}

function closedAbortReason(reason: unknown): MCPEgressGatewayError {
  return reason instanceof MCPEgressGatewayError ? reason : abortReasonError('shutdown');
}

interface GatewayOptions {
  db: TenantScopeAwareDatabase;
  app: Application;
  jwtSecret: string;
  branchRbacEnabled: boolean;
  allowLocalhostHttp?: boolean;
  resolveDns?: OutboundDnsLookup;
  /** Test seam proving all constituent reads share one native snapshot. */
  authoritySnapshotCheckpoint?: () => Promise<void>;
}

interface CurrentAuthority {
  unresolvedServer: MCPServer;
  server: MCPServer;
  env: Record<string, string>;
}

interface InFlight {
  tenantId: string;
  taskId: string;
  serverId: string;
  controller: AbortController;
  startedAt: number;
}

function capabilityToken(headers: Headers): string {
  const token = headers.get('x-agor-mcp-capability');
  if (!token) {
    throw new MCPEgressGatewayError(401, 'capability_required', 'MCP gateway capability required');
  }
  return token;
}

function protocolRequestHeaders(input: Headers): Headers {
  const output = new Headers();
  for (const name of [
    'accept',
    'content-type',
    'mcp-protocol-version',
    'mcp-session-id',
    'last-event-id',
  ]) {
    const value = input.get(name);
    if (value) output.set(name, value);
  }
  return output;
}

function publicResponseHeaders(input: Headers, secrets: string[]): Headers {
  const output = new Headers();
  for (const name of [
    'content-type',
    'cache-control',
    'mcp-session-id',
    'mcp-protocol-version',
    'retry-after',
  ]) {
    const value = input.get(name);
    if (value && !containsSecret(value, secrets)) output.set(name, value);
  }
  return output;
}

function usefulSecret(value: string): boolean {
  if (value.length < SECRET_MIN_LENGTH) return false;
  return new Set(value).size >= 4;
}

function usefulLiteralUrlSecret(value: string): boolean {
  return value.length >= 16 && new Set(value).size >= 8;
}

function secretVariants(value: string): string[] {
  const raw = value.replace(/^(?:Bearer|Basic)\s+/i, '');
  return [value, raw].filter(usefulSecret);
}

function containsSecret(value: string, secrets: string[]): boolean {
  return secrets.some((secret) => value.includes(secret));
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
}

function urlMaterial(url?: string): string[] {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    return [
      ...parsed.pathname.split('/').flatMap((part) => {
        try {
          return [decodeURIComponent(part)];
        } catch {
          return [part];
        }
      }),
      ...[...parsed.searchParams.values()],
    ];
  } catch {
    return [url];
  }
}

function authSecretMaterial(auth: MCPServer['auth']): string[] {
  if (!auth) return [];
  return [
    auth.token,
    auth.api_token,
    auth.api_secret,
    auth.oauth_client_id,
    auth.oauth_client_secret,
    auth.oauth_access_token,
    auth.oauth_refresh_token,
  ].filter((value): value is string => typeof value === 'string');
}

function assertNoDecodedSecret(value: unknown, secrets: string[]): void {
  if (typeof value === 'string') {
    if (containsSecret(value, secrets)) {
      throw new MCPEgressGatewayError(
        502,
        'credential_reflection_blocked',
        'The MCP response reflected daemon-owned credential material'
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoDecodedSecret(item, secrets);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoDecodedSecret(key, secrets);
      assertNoDecodedSecret(item, secrets);
    }
  }
}

function validateBufferedMCPResponse(
  response: Response,
  body: Uint8Array,
  secrets: string[]
): Uint8Array {
  if (body.byteLength === 0) return body;
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const text = Buffer.from(body).toString('utf8');
  if (contentType === 'application/json' || contentType?.endsWith('+json')) {
    try {
      assertNoDecodedSecret(JSON.parse(text), secrets);
      return body;
    } catch (error) {
      if (error instanceof MCPEgressGatewayError) throw error;
      throw new MCPEgressGatewayError(
        502,
        'invalid_mcp_json',
        'Provider returned invalid MCP JSON'
      );
    }
  }
  if (contentType === 'text/event-stream') {
    const events = text.split(/\r?\n\r?\n/);
    const released: string[] = [];
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        assertNoDecodedSecret(parsed, secrets);
        released.push(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch (error) {
        if (error instanceof MCPEgressGatewayError) throw error;
        throw new MCPEgressGatewayError(
          502,
          'unstructured_sse_not_mediated',
          'Only bounded JSON MCP SSE events are mediated'
        );
      }
    }
    return new TextEncoder().encode(released.join(''));
  }
  throw new MCPEgressGatewayError(
    502,
    'unstructured_response_not_mediated',
    'Only bounded JSON or JSON SSE MCP responses are mediated'
  );
}

function requestedToolNames(body?: Uint8Array): string[] {
  if (!body?.byteLength) return [];
  try {
    const value = JSON.parse(Buffer.from(body).toString('utf8')) as
      | { method?: unknown; params?: { name?: unknown } }
      | Array<{ method?: unknown; params?: { name?: unknown } }>;
    const requests = Array.isArray(value) ? value : [value];
    return requests.flatMap((request) =>
      request.method === 'tools/call' && typeof request.params?.name === 'string'
        ? [request.params.name]
        : []
    );
  } catch {
    return [];
  }
}

function templateKeys(server: MCPServer): Set<string> {
  const dependencies = extractMCPTemplateDependencies(server);
  if (!dependencies.valid) {
    throw new MCPEgressGatewayError(
      409,
      'template_dependency_unknown',
      'MCP template dependencies cannot be determined'
    );
  }
  return dependencies.keys;
}

function durableAuthMaterial(auth: MCPServer['auth']): MCPServer['auth'] {
  if (!auth) return auth;
  const {
    oauth_access_token: _access,
    oauth_refresh_token: _refresh,
    oauth_token_expires_at: _expires,
    ...durable
  } = auth;
  return durable as MCPServer['auth'];
}

export function mcpEgressMaterialHash(
  server: MCPServer,
  env: Record<string, string>,
  secret: string
): string {
  const referenced = [...templateKeys(server)].sort().map((key) => [key, env[key] ?? null]);
  return createHmac('sha256', secret)
    .update('agor:mcp-egress-material:v2\0')
    .update(
      JSON.stringify({
        configVersion: server.config_version ?? 1,
        url: server.url,
        command: server.command,
        args: server.args,
        env: server.env,
        headers: server.headers,
        auth: durableAuthMaterial(server.auth),
        referenced,
      })
    )
    .digest('base64url');
}

export function mcpOAuthGrantIdentity(
  row: {
    grant_generation?: number;
    grant_binding_fingerprint?: string | null;
  } | null
): string | undefined {
  if (!row) return undefined;
  return `${row.grant_generation ?? 0}:${row.grant_binding_fingerprint ?? '<unbound>'}`;
}

export async function resolveMCPEgressEnvironment(
  tenantDb: TenantScopedDatabase,
  userId: string,
  session: Pick<Session, 'session_id' | 'custom_context'>
): Promise<Record<string, string>> {
  const { createUserProcessEnvironment } = await import('@agor/core/config');
  const gatewaySource = (session.custom_context as Record<string, unknown> | undefined)
    ?.gateway_source as { channel_id?: string } | undefined;
  let gatewayEnv: GatewayEnvVar[] | undefined;
  if (gatewaySource?.channel_id) {
    const channel = await new GatewayChannelRepository(tenantDb).findById(gatewaySource.channel_id);
    if (channel?.agentic_config?.envVars) {
      gatewayEnv = channel.agentic_config.envVars.map((entry) => ({
        ...entry,
        value:
          entry.value && isEncrypted(entry.value)
            ? (() => {
                try {
                  return decryptApiKey(entry.value);
                } catch {
                  throw new MCPEgressGatewayError(
                    503,
                    'credential_decryption_failed',
                    'MCP credential material could not be decrypted'
                  );
                }
              })()
            : entry.value,
      }));
    }
    if (channel) {
      const connectorEnv = getConnector(channel.channel_type, channel.config).sessionEnv?.() ?? [];
      const present = new Set((gatewayEnv ?? []).map((entry) => entry.key));
      gatewayEnv = [
        ...(gatewayEnv ?? []),
        ...connectorEnv.filter((entry) => !present.has(entry.key)),
      ];
    }
  }
  return createUserProcessEnvironment(
    userId as UserID,
    tenantDb,
    undefined,
    gatewayEnv,
    session.session_id as SessionID
  );
}

export class MCPEgressGateway {
  private readonly inFlight = new Map<string, InFlight>();
  private readonly reservations = new Map<string, InFlight>();

  constructor(private readonly options: GatewayOptions) {}

  verify(token: string): MCPEgressCapabilityClaims {
    try {
      return verifyMCPEgressCapability(token, this.options.jwtSecret);
    } catch {
      throw new MCPEgressGatewayError(401, 'invalid_capability', 'MCP capability is invalid');
    }
  }

  /** Reproducible admission benchmark/probe; it resolves no provider credential and sends nothing. */
  async checkAdmission(token: string, serverId: string): Promise<void> {
    const claims = this.verify(token);
    if (claims.mcp_server_id !== serverId) {
      throw new MCPEgressGatewayError(
        403,
        'capability_scope_mismatch',
        'Capability/server mismatch'
      );
    }
    await this.currentAuthority(claims);
  }

  status(tenantId: string) {
    const providerRequests = [...this.inFlight.values()].filter(
      (request) => request.tenantId === tenantId
    );
    const reservations = [...this.reservations.values()].filter(
      (request) => request.tenantId === tenantId
    );
    const activeRequests = [...providerRequests, ...reservations];
    return {
      // Keep the established field as a total so existing health consumers do
      // not silently omit credential/admission reservations.
      inFlightRequests: activeRequests.length,
      activeRequests: activeRequests.length,
      providerInFlightRequests: providerRequests.length,
      reservedRequests: reservations.length,
      oldestRequestMs: activeRequests.length
        ? Math.max(...activeRequests.map((request) => Date.now() - request.startedAt))
        : 0,
    };
  }

  /** Best-effort availability accelerator. Correctness comes from DB revalidation. */
  abortServer(
    tenantId: string,
    serverId: string,
    reason: MCPEgressServerAbortReason = 'stale_capability'
  ): number {
    let aborted = 0;
    for (const request of [...this.inFlight.values(), ...this.reservations.values()]) {
      if (request.tenantId === tenantId && request.serverId === serverId) {
        request.controller.abort(abortReasonError(reason));
        aborted += 1;
      }
    }
    return aborted;
  }

  abortTenant(tenantId: string): number {
    let aborted = 0;
    for (const request of [...this.inFlight.values(), ...this.reservations.values()]) {
      if (request.tenantId === tenantId) {
        request.controller.abort(abortReasonError('rollout_changed'));
        aborted += 1;
      }
    }
    return aborted;
  }

  close(): void {
    for (const request of [...this.inFlight.values(), ...this.reservations.values()]) {
      request.controller.abort(abortReasonError('shutdown'));
    }
  }

  /** Resolve a pre-socket cancellation without trusting arbitrary signal text. */
  private async rejectPreDispatch(
    claims: MCPEgressCapabilityClaims,
    abortReason: unknown
  ): Promise<never> {
    try {
      // The committed database state is authoritative when it can return a
      // structured rejection. The local abort is only an accelerator.
      await this.currentAuthority(claims);
    } catch (error) {
      if (error instanceof MCPEgressGatewayError) throw error;
    }
    throw closedAbortReason(abortReason);
  }

  private async assertCurrentOrAbort(
    claims: MCPEgressCapabilityClaims,
    signal: AbortSignal
  ): Promise<void> {
    // Revalidate first so a committed mutation wins over its local hint.
    await this.currentAuthority(claims);
    if (signal.aborted) throw closedAbortReason(signal.reason);
  }

  private assertCapacity(claims: MCPEgressCapabilityClaims): void {
    const requests = [...this.inFlight.values(), ...this.reservations.values()];
    const exceeded =
      requests.length >= MAX_PROCESS_IN_FLIGHT ||
      requests.filter((item) => item.tenantId === claims.tid).length >= MAX_TENANT_IN_FLIGHT ||
      requests.filter((item) => item.taskId === claims.task_id).length >= MAX_TASK_IN_FLIGHT ||
      requests.filter((item) => item.serverId === claims.mcp_server_id).length >=
        MAX_SERVER_IN_FLIGHT;
    if (exceeded) {
      throw new MCPEgressGatewayError(
        429,
        'egress_capacity_exceeded',
        'MCP gateway capacity is temporarily exhausted; retry with backoff'
      );
    }
  }

  private async currentAuthority(claims: MCPEgressCapabilityClaims): Promise<CurrentAuthority> {
    return runWithTenantDatabaseTransaction(
      this.options.db,
      claims.tid,
      async (tenantDb) => {
        const mode = await getMCPEgressGatewayMode(tenantDb);
        if (mode !== claims.rollout_mode || (mode !== 'compatibility' && mode !== 'enforced')) {
          throw new MCPEgressGatewayError(
            409,
            'rollout_changed',
            'MCP gateway rollout changed; reconnect this task'
          );
        }
        const [task, session, server, principal, credentialUser] = await Promise.all([
          new TaskRepository(tenantDb).findById(claims.task_id),
          new SessionRepository(tenantDb).findById(claims.session_id),
          new MCPServerRepository(tenantDb).findById(claims.mcp_server_id),
          new UsersRepository(tenantDb).findById(claims.principal_user_id),
          new UsersRepository(tenantDb).findById(claims.credential_user_id),
        ]);
        if (
          !task ||
          task.session_id !== claims.session_id ||
          task.created_by !== claims.principal_user_id ||
          task.created_by !== claims.credential_user_id ||
          !ACTIVE_TASK_STATES.has(task.status) ||
          !session ||
          !server ||
          !server.enabled ||
          !principal ||
          !credentialUser ||
          !hasMinimumRole(principal.role, ROLES.MEMBER) ||
          !hasMinimumRole(credentialUser.role, ROLES.MEMBER) ||
          !isMCPServerUsableBy(server, claims.credential_user_id)
        ) {
          throw new MCPEgressGatewayError(403, 'principal_revoked', 'MCP task authority changed');
        }
        await this.options.authoritySnapshotCheckpoint?.();
        const eligibility = mcpEgressEligibility(server);
        if (!eligibility.eligible) {
          throw new MCPEgressGatewayError(
            501,
            eligibility.reason,
            eligibility.reason === 'approval_not_mediated'
              ? 'This server requires one-shot approval and is excluded from mediation'
              : eligibility.reason === 'template_configuration'
                ? 'This server uses a template form the gateway cannot mediate; use static user.env.KEY references with supported balanced helpers'
                : 'This phase mediates only bounded Streamable HTTP; stdio and legacy SSE fail closed'
          );
        }
        if ((server.config_version ?? 1) !== claims.config_version) {
          throw new MCPEgressGatewayError(
            409,
            'stale_capability',
            'MCP server configuration changed; reconnect this task'
          );
        }
        if (server.scope !== 'global') {
          const attached = await new SessionMCPServerRepository(tenantDb).listServers(
            claims.session_id as SessionID,
            true
          );
          if (!attached.some((candidate) => candidate.mcp_server_id === server.mcp_server_id)) {
            throw new MCPEgressGatewayError(403, 'server_detached', 'MCP server was detached');
          }
        }
        if (this.options.branchRbacEnabled) {
          const branchRepository = new BranchRepository(tenantDb);
          const branch = await branchRepository.findById(session.branch_id);
          if (!branch) throw new MCPEgressGatewayError(403, 'branch_revoked', 'Branch unavailable');
          const promptAccess = await resolveSessionPromptAccess({
            branchRepository,
            branch,
            session,
            userId: claims.principal_user_id as UserID,
          });
          if (!promptAccess.allowed) {
            throw new MCPEgressGatewayError(403, 'branch_revoked', 'Branch permission changed');
          }
        }
        if (server.auth?.type === 'oauth') {
          const tokenUserId =
            (server.auth.oauth_mode ?? 'per_user') === 'shared'
              ? null
              : (claims.credential_user_id as UserID);
          const grant = await new UserMCPOAuthTokenRepository(tenantDb).getToken(
            tokenUserId,
            server.mcp_server_id
          );
          if (!claims.grant_identity || mcpOAuthGrantIdentity(grant) !== claims.grant_identity) {
            throw new MCPEgressGatewayError(
              401,
              'grant_changed',
              'MCP OAuth grant was replaced or revoked; reconnect this task'
            );
          }
        } else if (claims.grant_identity) {
          throw new MCPEgressGatewayError(409, 'grant_changed', 'MCP grant identity changed');
        }
        const env = await resolveMCPEgressEnvironment(tenantDb, claims.credential_user_id, session);
        if (mcpEgressMaterialHash(server, env, this.options.jwtSecret) !== claims.material_hash) {
          throw new MCPEgressGatewayError(
            409,
            'credential_material_changed',
            'MCP credential material changed; reconnect this task'
          );
        }
        const resolved = resolveMcpServerTemplates(server, buildMCPTemplateContextFromEnv(env));
        if (!resolved.isValid) {
          throw new MCPEgressGatewayError(
            409,
            'template_resolution_failed',
            'MCP template resolution failed'
          );
        }
        return { unresolvedServer: server, server: resolved.server, env };
      },
      { postgresIsolationLevel: 'repeatable read' }
    );
  }

  private async credentialHeaders(
    claims: MCPEgressCapabilityClaims,
    server: MCPServer,
    assertCurrent: () => Promise<void>
  ): Promise<Headers> {
    let authHeaders: Record<string, string> | undefined;
    if (server.auth?.type === 'oauth') {
      let result: { headers: Record<string, { authorization?: string; error?: string }> };
      try {
        result = (await this.options.app
          .service('mcp-servers/oauth-auth-headers')
          .create({ mcp_server_ids: [server.mcp_server_id] }, {
            provider: undefined,
            tenant: { tenant_id: claims.tid },
            session_id: claims.session_id,
            user: {
              user_id: claims.credential_user_id,
              role: 'service',
              _isServiceAccount: true,
            },
            mcp_egress_assert_current: assertCurrent,
          } as unknown as AuthenticatedParams)) as typeof result;
      } catch (error) {
        // Preserve the typed known-no-send outcome, while allowing durable
        // authority to supersede the local accelerator reason when reachable.
        if (error instanceof OAuthRefreshAuthorityCancelledError) {
          return this.rejectPreDispatch(claims, error.authorityCause);
        }
        // A non-refresh service failure may still have raced a mutation before
        // credential resolution completed; prefer the current gateway reason.
        await assertCurrent();
        throw error;
      }
      const entry = result.headers[server.mcp_server_id];
      if (!entry?.authorization) {
        throw new MCPEgressGatewayError(
          401,
          entry?.error ?? 'needs_reauth',
          'MCP OAuth authentication requires recovery'
        );
      }
      authHeaders = { Authorization: entry.authorization };
    } else if (server.auth?.type === 'jwt') {
      const { api_url: apiUrl, api_token: apiToken, api_secret: apiSecret } = server.auth;
      if (!apiUrl || !apiToken || !apiSecret) {
        throw new MCPEgressGatewayError(
          401,
          'credential_resolution_failed',
          'MCP JWT credential configuration is incomplete'
        );
      }
      let token: string;
      try {
        token = await fetchJWTToken(
          { api_url: apiUrl, api_token: apiToken, api_secret: apiSecret },
          {
            allowLocalhostHttp: this.options.allowLocalhostHttp === true,
            cacheNamespace: `${claims.tid}:${server.mcp_server_id}:${claims.config_version}`,
            cache: false,
            resolveDns: this.options.resolveDns,
            assertBeforeDispatch: async () => {
              await assertCurrent();
            },
          }
        );
      } catch (error) {
        // The shared JWT helper intentionally sanitizes provider failures. If
        // its dispatch assertion lost authority, reloading here restores the
        // stable gateway reason without exposing the provider exception.
        await this.currentAuthority(claims);
        throw error;
      }
      authHeaders = { Authorization: `Bearer ${token}` };
    } else {
      authHeaders = await resolveMCPAuthHeaders(server.auth, server.url, {
        allowLocalhostHttp: this.options.allowLocalhostHttp === true,
        cacheNamespace: `${claims.tid}:${server.mcp_server_id}:${claims.config_version}`,
        disableProcessTokenCache: true,
      });
      if (server.auth && server.auth.type !== 'none' && !authHeaders?.Authorization) {
        throw new MCPEgressGatewayError(
          401,
          'credential_resolution_failed',
          'MCP credential resolution failed closed'
        );
      }
    }
    return new Headers(authHeaders);
  }

  private responseSecrets(
    unresolvedServer: MCPServer,
    resolvedServer: MCPServer,
    env: Record<string, string>,
    headers: Headers
  ): string[] {
    const values = [
      ...headers.values(),
      ...stringLeaves(resolvedServer.env),
      ...stringLeaves(resolvedServer.headers),
      ...authSecretMaterial(resolvedServer.auth),
      ...urlMaterial(resolvedServer.url).filter(usefulLiteralUrlSecret),
      ...[...templateKeys(unresolvedServer)].flatMap((key) => (env[key] ? [env[key]] : [])),
    ];
    return [...new Set(values.flatMap(secretVariants))];
  }

  async forward(input: {
    serverId: string;
    headers: Headers;
    method: string;
    body?: Uint8Array;
  }): Promise<{
    response: Response;
    claims: MCPEgressCapabilityClaims;
  }> {
    if (input.method !== 'POST' && input.method !== 'DELETE') {
      throw new MCPEgressGatewayError(
        405,
        'method_not_mediated',
        'This MCP gateway phase mediates only bounded POST and DELETE requests'
      );
    }
    const claims = this.verify(capabilityToken(input.headers));
    if (claims.mcp_server_id !== input.serverId) {
      throw new MCPEgressGatewayError(
        403,
        'capability_scope_mismatch',
        'Capability/server mismatch'
      );
    }
    if (input.body && input.body.byteLength > MAX_REQUEST_BYTES) {
      throw new MCPEgressGatewayError(413, 'request_too_large', 'MCP gateway request is too large');
    }
    this.assertCapacity(claims);
    const reservationId = randomUUID();
    const controller = new AbortController();
    this.reservations.set(reservationId, {
      tenantId: claims.tid,
      taskId: claims.task_id,
      serverId: input.serverId,
      controller,
      startedAt: Date.now(),
    });
    let admitted: CurrentAuthority;
    let credentials: Headers;
    try {
      // This one native snapshot is the source of every server-controlled
      // value below: policy, credential configuration, destination, custom
      // headers, template material, and reflection candidates.
      admitted = await this.currentAuthority(claims);
      for (const toolName of requestedToolNames(input.body)) {
        const permission = admitted.server.tool_permissions?.[toolName];
        if (permission === 'deny') {
          throw new MCPEgressGatewayError(403, 'tool_denied', 'MCP tool is disabled');
        }
        if (permission === 'ask') {
          throw new MCPEgressGatewayError(
            403,
            'approval_not_mediated',
            'This server requires one-shot tool approval and must be reconfigured before mediation'
          );
        }
      }
      const assertCurrent = async () => {
        await this.assertCurrentOrAbort(claims, controller.signal);
      };
      credentials = await this.credentialHeaders(claims, admitted.server, assertCurrent);
    } catch (error) {
      this.reservations.delete(reservationId);
      throw error;
    }
    const headers = protocolRequestHeaders(input.headers);
    const finalHeaders = new Headers(
      mergeMCPRemoteHeaders({
        custom: admitted.server.headers,
        auth: Object.fromEntries(credentials.entries()),
      })
    );
    for (const [name, value] of finalHeaders) headers.set(name, value);
    const requestId = randomUUID();
    const tracked: InFlight = {
      tenantId: claims.tid,
      taskId: claims.task_id,
      serverId: input.serverId,
      controller,
      startedAt: Date.now(),
    };
    this.reservations.delete(reservationId);
    this.inFlight.set(requestId, tracked);
    const timer = getDaemonMetrics(this.options.app).startTimer('mcp_egress.proxy_ms', {
      transport: 'http-buffered',
    });
    try {
      // Defensible linearization point: each outbound hop is admitted only
      // after this durable current-version/identity check completes. A mutation
      // committed later may allow this already-admitted request to complete.
      const assertCurrent = async () => {
        await this.assertCurrentOrAbort(claims, controller.signal);
      };
      const response = await safeOutboundFetch(admitted.server.url!, {
        method: input.method,
        headers,
        body: input.method === 'DELETE' ? undefined : input.body,
        redirect: 'error',
        timeoutMs: RESPONSE_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        allowLocalhostHttp: this.options.allowLocalhostHttp === true,
        signal: controller.signal,
        resolveDns: this.options.resolveDns,
        assertCurrent,
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const secrets = this.responseSecrets(
        admitted.unresolvedServer,
        admitted.server,
        admitted.env,
        finalHeaders
      );
      const releasedBody = validateBufferedMCPResponse(response, body, secrets);
      timer({ outcome: 'complete' });
      return {
        response: new Response(releasedBody, {
          status: response.status,
          headers: publicResponseHeaders(response.headers, secrets),
        }),
        claims,
      };
    } catch (error) {
      timer({ outcome: controller.signal.aborted ? 'aborted' : 'error' });
      // Re-resolve the authoritative rejection when possible; otherwise only
      // the closed local abort vocabulary may cross the route boundary.
      if (error instanceof OutboundPreDispatchAuthorityError) {
        return this.rejectPreDispatch(claims, error.authorityCause);
      }
      throw error;
    } finally {
      this.inFlight.delete(requestId);
    }
  }
}
