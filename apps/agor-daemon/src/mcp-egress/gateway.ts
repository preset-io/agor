import { createHmac, randomUUID } from 'node:crypto';
import {
  BranchRepository,
  decryptApiKey,
  GatewayChannelRepository,
  getMCPEgressGatewayMode,
  isEncrypted,
  MCPServerRepository,
  runWithTenantDatabaseScope,
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
  mcpRuntimeProviderCapability,
  resolveMcpServerTemplates,
} from '@agor/core/mcp';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import { fetchJWTToken, resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import { OAuthRefreshAuthorityCancelledError } from '@agor/core/tools/mcp/oauth-refresh';
import type {
  AuthenticatedParams,
  GatewayEnvVar,
  MCPRuntimeProviderCapability,
  MCPRuntimeRecovery,
  MCPRuntimeServerState,
  MCPServer,
  MCPServerID,
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
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { DIRECT_MODE_MCP_RECOVERY_MESSAGE } from '../utils/mcp-runtime-hints.js';
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

/** Secret-free mixed readiness classification shared by the reprojection route and tests. */
export function classifyMCPRuntimeProjection(
  projected: MCPServer[],
  visible: MCPServer[],
  _provider: MCPRuntimeProviderCapability
): MCPRuntimeServerState[] {
  const readyIds = new Set(projected.map((server) => server.mcp_server_id));
  return visible.map((server) => {
    if (readyIds.has(server.mcp_server_id)) {
      return {
        mcp_server_id: server.mcp_server_id,
        name: server.name,
        code: 'ready',
        action: 'none',
        message: 'Ready through the daemon MCP gateway.',
      };
    }
    const eligibility = mcpEgressEligibility(server);
    const code = eligibility.eligible ? 'oauth_reauth_required' : eligibility.reason;
    return {
      mcp_server_id: server.mcp_server_id,
      name: server.name,
      code,
      action: code === 'oauth_reauth_required' ? 'reauthenticate' : 'review_configuration',
      message:
        code === 'oauth_reauth_required'
          ? 'OAuth authority was replaced or disconnected; sign in again.'
          : code === 'approval_not_mediated'
            ? 'This server requires interactive approval, which mediated egress does not support in the current turn.'
            : code === 'template_configuration'
              ? 'This server template cannot be mediated; review its static user.env references or detach it.'
              : 'This server transport cannot be mediated; replace it with bounded Streamable HTTP or detach it.',
    };
  });
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
    message: string,
    readonly dispatch: 'not_started' | 'ambiguous' = 'not_started',
    /** Keyed current-authority hash captured before this no-send rejection. */
    readonly authorityFingerprint?: string
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

function closedAbortReason(
  reason: unknown,
  installedAuthorityFingerprint?: string
): MCPEgressGatewayError {
  const error = reason instanceof MCPEgressGatewayError ? reason : abortReasonError('shutdown');
  return installedAuthorityFingerprint && !error.authorityFingerprint
    ? new MCPEgressGatewayError(
        error.status,
        error.code,
        error.message,
        error.dispatch,
        installedAuthorityFingerprint
      )
    : error;
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
  sessionId: string;
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

export function mcpToolPolicyHash(
  permissions: MCPServer['tool_permissions'],
  secret: string
): string {
  return createHmac('sha256', secret)
    .update(
      JSON.stringify(
        Object.entries(permissions ?? {}).sort(([left], [right]) => left.localeCompare(right))
      )
    )
    .digest('base64url');
}

/** Keyed, secret-free identity of one server's complete projected authority. */
export function mcpAuthorityFingerprint(
  input: {
    serverId: string;
    rolloutMode: string;
    configVersion: number;
    materialHash: string;
    toolPolicyHash: string;
    grantIdentity?: string;
  },
  secret: string
): string {
  return createHmac('sha256', secret)
    .update('agor:mcp-authority-fingerprint:v1\0')
    .update(JSON.stringify(input))
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

  /** Persist a bounded, secret-free recovery projection after gateway rejection. */
  async recordRejectedRequest(
    headers: Headers,
    serverId: string,
    error: MCPEgressGatewayError
  ): Promise<void> {
    // Capture the rejection before any database wait. A later refresh/action
    // must never be regressed by this best-effort projection.
    const rejectedAt = new Date();
    const recoverable = new Set([
      'stale_capability',
      'grant_changed',
      'needs_reauth',
      'credential_material_changed',
      'server_detached',
      'principal_revoked',
      'branch_revoked',
      'rollout_changed',
      'transport_not_mediated',
      'approval_not_mediated',
      'template_configuration',
      'tool_permission_changed',
    ]);
    if (!recoverable.has(error.code)) return;
    let claims: MCPEgressCapabilityClaims;
    try {
      claims = this.verify(capabilityToken(headers));
    } catch {
      return;
    }
    if (claims.mcp_server_id !== serverId) return;
    await runWithTenantDatabaseScope(this.options.db, claims.tid, async (tenantDb) => {
      const repo = new TaskRepository(tenantDb);
      const session = await new SessionRepository(tenantDb).findById(claims.session_id);
      const updated = await repo.recordMCPRecovery(claims.task_id, async (current, task, txDb) => {
        if (
          task.session_id !== claims.session_id ||
          !ACTIVE_TASK_STATES.has(task.status) ||
          task.created_by !== claims.principal_user_id
        ) {
          return null;
        }
        if (!session) return null;
        const issuedGeneration = claims.recovery_generation ?? 0;
        const rejectionObservedSettledAuthority =
          error.authorityFingerprint !== undefined &&
          task.metadata?.mcp_recovery_settled_authority_fingerprints?.includes(
            error.authorityFingerprint
          );
        if (!current && rejectionObservedSettledAuthority) {
          // A successful refresh already installed this exact authority. A
          // late rejection that observed it must not recreate UI recovery;
          // request and wall-clock identity alone cannot prove that because a
          // newly stale rejection may share the settlement's millisecond.
          return null;
        }
        const rolloutMode = await getMCPEgressGatewayMode(txDb);
        if (rolloutMode === 'off' || rolloutMode === 'observe') {
          if (
            current?.code === 'rollout_changed' &&
            current.status === 'action_required' &&
            current.action === 'retry_next_turn'
          ) {
            return null;
          }
          return {
            ...(current ?? {}),
            generation: (current?.generation ?? 0) + 1,
            code: 'rollout_changed',
            status: 'action_required',
            task_id: task.task_id,
            session_id: task.session_id,
            mcp_server_id: undefined,
            mcp_server_name: undefined,
            server_states: undefined,
            provider: mcpRuntimeProviderCapability(session.agentic_tool),
            action: 'retry_next_turn',
            message: DIRECT_MODE_MCP_RECOVERY_MESSAGE,
            observed_at: rejectedAt.toISOString(),
            request_id: undefined,
            refresh_deadline_at: undefined,
            provider_dispatch: error.dispatch,
          };
        }
        if (current) {
          if (current.generation > issuedGeneration) return null;
          if (
            current.generation === issuedGeneration &&
            current.request_id &&
            current.request_id !== claims.recovery_request_id
          ) {
            return null;
          }
        }
        const provider = mcpRuntimeProviderCapability(session.agentic_tool);
        const rejectedServer = await new MCPServerRepository(txDb).findById(serverId);
        const code: MCPRuntimeRecovery['code'] =
          error.code === 'needs_reauth'
            ? 'oauth_reauth_required'
            : (error.code as MCPRuntimeRecovery['code']);
        const permanentExclusion =
          code === 'transport_not_mediated' ||
          code === 'approval_not_mediated' ||
          code === 'template_configuration';
        const action: MCPRuntimeRecovery['action'] =
          code === 'oauth_reauth_required'
            ? 'reauthenticate'
            : code === 'principal_revoked' || code === 'branch_revoked'
              ? 'contact_admin'
              : permanentExclusion
                ? 'review_configuration'
                : provider.transport_reload
                  ? 'reconnect_mcp'
                  : 'retry_next_turn';
        if (
          current?.code === code &&
          current.mcp_server_id === (serverId as MCPServerID) &&
          current.status === 'action_required' &&
          (current.provider_dispatch === 'ambiguous' ||
            current.provider_dispatch === error.dispatch)
        ) {
          return null;
        }
        return {
          generation: (current?.generation ?? 0) + 1,
          code,
          status: 'action_required',
          task_id: task.task_id,
          session_id: task.session_id,
          mcp_server_id: serverId as import('@agor/core/types').MCPServerID,
          ...(rejectedServer?.name ? { mcp_server_name: rejectedServer.name } : {}),
          server_states: permanentExclusion
            ? [
                {
                  mcp_server_id: serverId as MCPServerID,
                  name: rejectedServer?.name ?? 'MCP server',
                  code,
                  action: 'review_configuration',
                  message:
                    code === 'approval_not_mediated'
                      ? 'Interactive ask approval is not mediated; change the tool policy or detach this server.'
                      : code === 'template_configuration'
                        ? 'The gateway cannot mediate this template configuration; review or detach this server.'
                        : 'This transport is not mediated; replace it with bounded Streamable HTTP or detach this server.',
                },
              ]
            : current?.server_states,
          provider,
          action,
          message:
            error.dispatch === 'ambiguous'
              ? 'The provider request may have started. Agor will never replay it automatically; reconnecting only updates MCP transport for subsequent calls.'
              : action === 'reauthenticate'
                ? 'MCP authorization changed. Sign in again, then reconnect this task.'
                : action === 'contact_admin' || action === 'review_configuration'
                  ? permanentExclusion
                    ? code === 'approval_not_mediated'
                      ? 'This server requires interactive approval, which mediated egress does not support. Change its tool policy or detach it.'
                      : code === 'template_configuration'
                        ? 'This server uses a template form the gateway cannot mediate. Review its configuration or detach it.'
                        : 'This server transport cannot be mediated during this turn. Replace it with bounded Streamable HTTP or detach it.'
                    : 'Your authority for this active MCP task changed. Contact an administrator.'
                  : provider.transport_reload
                    ? 'MCP authority changed before provider dispatch. Reconnect MCP to continue this conversation.'
                    : 'MCP authority changed. This provider can apply it only on the next turn; the conversation handle is preserved.',
          observed_at: rejectedAt.toISOString(),
          provider_dispatch: error.dispatch,
        };
      });
      if (!ACTIVE_TASK_STATES.has(updated.status) || !updated.metadata?.mcp_recovery) return;
      emitServiceEvent(this.options.app, {
        path: 'tasks',
        event: 'patched',
        data: updated,
        id: updated.task_id,
        params: {
          tenant: {
            tenant_id: claims.tid as import('@agor/core/types').TenantID,
            source: 'explicit',
          },
        },
      });
    });
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

  /** Availability accelerator restricted to the detached Session/server pair. */
  abortSessionServer(tenantId: string, sessionId: string, serverId: string): number {
    let aborted = 0;
    for (const request of [...this.inFlight.values(), ...this.reservations.values()]) {
      if (
        request.tenantId === tenantId &&
        request.sessionId === sessionId &&
        request.serverId === serverId
      ) {
        request.controller.abort(abortReasonError('server_detached'));
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
    throw closedAbortReason(abortReason, claims.authority_fingerprint);
  }

  private async assertCurrentOrAbort(
    claims: MCPEgressCapabilityClaims,
    signal: AbortSignal
  ): Promise<void> {
    // Revalidate first so a committed mutation wins over its local hint.
    await this.currentAuthority(claims);
    if (signal.aborted) throw closedAbortReason(signal.reason, claims.authority_fingerprint);
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
        if (!server) {
          throw new MCPEgressGatewayError(403, 'server_detached', 'MCP server was removed');
        }
        if (
          !task ||
          task.session_id !== claims.session_id ||
          task.created_by !== claims.principal_user_id ||
          task.created_by !== claims.credential_user_id ||
          !ACTIVE_TASK_STATES.has(task.status) ||
          !session ||
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
              ? 'This server requires interactive approval and is excluded from mediated egress'
              : eligibility.reason === 'template_configuration'
                ? 'This server uses a template form the gateway cannot mediate; use static user.env.KEY references with supported balanced helpers'
                : 'This phase mediates only bounded Streamable HTTP; stdio and legacy SSE fail closed'
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
        let currentGrantIdentity: string | undefined;
        if (server.auth?.type === 'oauth') {
          const tokenUserId =
            (server.auth.oauth_mode ?? 'per_user') === 'shared'
              ? null
              : (claims.credential_user_id as UserID);
          const grant = await new UserMCPOAuthTokenRepository(tenantDb).getToken(
            tokenUserId,
            server.mcp_server_id
          );
          currentGrantIdentity = mcpOAuthGrantIdentity(grant);
        }
        const env = await resolveMCPEgressEnvironment(tenantDb, claims.credential_user_id, session);
        const currentMaterialHash = mcpEgressMaterialHash(server, env, this.options.jwtSecret);
        const currentToolPolicyHash = mcpToolPolicyHash(
          server.tool_permissions,
          this.options.jwtSecret
        );
        const currentAuthorityFingerprint = mcpAuthorityFingerprint(
          {
            serverId: server.mcp_server_id,
            rolloutMode: mode,
            configVersion: server.config_version ?? 1,
            materialHash: currentMaterialHash,
            toolPolicyHash: currentToolPolicyHash,
            grantIdentity: currentGrantIdentity,
          },
          this.options.jwtSecret
        );
        if ((server.config_version ?? 1) !== claims.config_version) {
          if (!claims.tool_policy_hash || claims.tool_policy_hash !== currentToolPolicyHash) {
            throw new MCPEgressGatewayError(
              409,
              'tool_permission_changed',
              'MCP tool permissions changed; refresh transport and apply tool visibility next turn',
              'not_started',
              currentAuthorityFingerprint
            );
          }
          throw new MCPEgressGatewayError(
            409,
            'stale_capability',
            'MCP server configuration changed; reconnect this task',
            'not_started',
            currentAuthorityFingerprint
          );
        }
        if (server.auth?.type === 'oauth') {
          if (!claims.grant_identity || currentGrantIdentity !== claims.grant_identity) {
            throw new MCPEgressGatewayError(
              401,
              'grant_changed',
              'MCP OAuth grant was replaced or revoked; reconnect this task',
              'not_started',
              currentAuthorityFingerprint
            );
          }
        } else if (claims.grant_identity) {
          throw new MCPEgressGatewayError(
            409,
            'grant_changed',
            'MCP grant identity changed',
            'not_started',
            currentAuthorityFingerprint
          );
        }
        if (currentMaterialHash !== claims.material_hash) {
          throw new MCPEgressGatewayError(
            409,
            'credential_material_changed',
            'MCP credential material changed; reconnect this task',
            'not_started',
            currentAuthorityFingerprint
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
      sessionId: claims.session_id,
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
      const toolNames = requestedToolNames(input.body);
      for (const toolName of toolNames) {
        const permission = admitted.server.tool_permissions?.[toolName];
        if (permission === 'deny') {
          throw new MCPEgressGatewayError(403, 'tool_denied', 'MCP tool is disabled');
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
      sessionId: claims.session_id,
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
      if (error instanceof MCPEgressGatewayError) {
        throw new MCPEgressGatewayError(error.status, error.code, error.message, 'ambiguous');
      }
      throw error;
    } finally {
      this.inFlight.delete(requestId);
    }
  }
}
