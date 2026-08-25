import { redactMCPAuthSecrets } from '@agor/core/tools/mcp/auth-secrets';
import { redactMCPEnvSecrets } from '@agor/core/tools/mcp/env-secrets';
import { redactMCPCustomHeaders } from '@agor/core/tools/mcp/http-headers';
import type { MCPServer, Params } from '@agor/core/types';
import { authenticatedTaskExecutorRuntimeScope } from '../auth/executor-runtime-scope.js';

export type MCPSecretParams = Params & {
  authentication?: {
    strategy?: string;
    payload?: Record<string, unknown>;
  };
  user?: { role?: string; _isServiceAccount?: boolean };
  session_id?: string;
};

export interface MCPSecretExposureOptions {
  /**
   * Executor-session auth is used by task executors. Only allow it on routes
   * already narrowed to the verified session's attached MCP servers; never on
   * global `/mcp-servers` reads.
   */
  allowSessionToken?: boolean;
  sessionId?: string;
}

export function shouldExposeMCPServerSecretsForSessionToken(
  params?: MCPSecretParams,
  options: { sessionId?: string } = {}
): boolean {
  const sessionId = authenticatedTaskExecutorRuntimeScope(params)?.sessionId;
  return (
    !!params?.provider &&
    !!sessionId &&
    (!params.session_id || params.session_id === sessionId) &&
    (!options.sessionId || sessionId === options.sessionId)
  );
}

export function shouldExposeMCPServerSecrets(
  params?: MCPSecretParams,
  options: MCPSecretExposureOptions = {}
): boolean {
  // Internal service calls are trusted and need raw config to start executors,
  // discover tools, and resolve auth headers.
  if (!params?.provider) return true;

  // Service accounts may need raw config across provider boundaries. Ordinary
  // authenticated users (including admins) must receive redacted API payloads.
  if (params.user?._isServiceAccount || params.user?.role === 'service') return true;

  return (
    options.allowSessionToken === true &&
    shouldExposeMCPServerSecretsForSessionToken(params, { sessionId: options.sessionId })
  );
}

// Back-compat alias for older call-sites/tests; now covers auth+headers.
export const shouldExposeMCPHeaderSecrets = shouldExposeMCPServerSecrets;

export function redactMCPServerSecrets(server: MCPServer): MCPServer {
  const headers = redactMCPCustomHeaders(server.headers);
  const auth = redactMCPAuthSecrets(server.auth);
  // `env` is where a stdio server keeps its credentials, so it is redacted on
  // the same terms as `headers`: a shared (ownerless) row is usable — and
  // therefore readable — by every member, and its env routinely holds API keys.
  const env = redactMCPEnvSecrets(server.env);

  if (headers === server.headers && auth === server.auth && env === server.env) return server;

  return {
    ...server,
    ...(headers !== server.headers ? { headers } : {}),
    ...(auth !== server.auth ? { auth } : {}),
    ...(env !== server.env ? { env } : {}),
  };
}

// Back-compat alias for older call-sites/tests; now covers auth+headers+env.
export const redactMCPServerHeaderSecrets = redactMCPServerSecrets;
