import { redactMCPCustomHeaders } from '@agor/core/tools/mcp/http-headers';
import type { MCPServer, Params } from '@agor/core/types';

type HeaderSecretParams = Params & {
  authentication?: { strategy?: string };
  user?: { role?: string };
};

export function shouldExposeMCPHeaderSecrets(params?: HeaderSecretParams): boolean {
  if (!params?.provider) return true;
  const role = params.user?.role;
  return params.authentication?.strategy === 'session-token' || role === 'service';
}

export function redactMCPServerHeaderSecrets(server: MCPServer): MCPServer {
  if (!server.headers || Object.keys(server.headers).length === 0) return server;
  return {
    ...server,
    headers: redactMCPCustomHeaders(server.headers),
  };
}
