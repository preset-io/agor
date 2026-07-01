import { redactMCPAuthSecrets } from '@agor/core/tools/mcp/auth-secrets';
import { redactMCPCustomHeaders } from '@agor/core/tools/mcp/http-headers';
import type { MCPServer, Params } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import {
  type ExecutorSessionTokenPayload,
  getExecutorSessionTokenSessionId,
  isExecutorSessionTokenPayload,
} from '../auth/executor-session-token.js';

export type MCPSecretParams = Params & {
  authentication?: {
    strategy?: string;
    accessToken?: string;
    payload?: ExecutorSessionTokenPayload;
  };
  user?: { role?: string; _isServiceAccount?: boolean };
  session_id?: string;
};

export interface MCPSecretExposureOptions {
  /**
   * Session-token auth is used by executors. Only allow it on routes that have
   * already narrowed results to the authenticated session's attached MCP
   * servers; never on global `/mcp-servers` reads.
   */
  allowSessionToken?: boolean;
  sessionId?: string;
}

export function shouldExposeMCPServerSecretsForSessionToken(
  params?: MCPSecretParams,
  options: { sessionId?: string } = {}
): boolean {
  const payload = params?.authentication?.payload ?? decodeExecutorSessionPayload(params);
  const sessionId = params?.session_id ?? getPayloadSessionId(payload);
  return (
    !!params?.provider &&
    (params.authentication?.strategy === 'session-token' || payload?.type === 'executor-session') &&
    !!sessionId &&
    (!options.sessionId || sessionId === options.sessionId)
  );
}

function decodeExecutorSessionPayload(
  params?: MCPSecretParams
): ExecutorSessionTokenPayload | undefined {
  if (params?.authentication?.strategy !== 'jwt' || !params.authentication.accessToken) {
    return undefined;
  }

  const decoded = jwt.decode(params.authentication.accessToken);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return undefined;
  }

  if (!isExecutorSessionTokenPayload(decoded)) return undefined;

  return decoded;
}

function getPayloadSessionId(payload: ExecutorSessionTokenPayload | undefined): string | undefined {
  return payload ? getExecutorSessionTokenSessionId(payload) : undefined;
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

  if (headers === server.headers && auth === server.auth) return server;

  return {
    ...server,
    ...(headers !== server.headers ? { headers } : {}),
    ...(auth !== server.auth ? { auth } : {}),
  };
}

// Back-compat alias for older call-sites/tests; now covers auth+headers.
export const redactMCPServerHeaderSecrets = redactMCPServerSecrets;
