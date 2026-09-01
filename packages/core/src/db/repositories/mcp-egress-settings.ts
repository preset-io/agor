import type { MCPEgressGatewayMode } from '../../types';
import { MCP_EGRESS_GATEWAY_MODES } from '../../types';
import type { Database, TenantScopedDatabase } from '../client';
import { AppVariableRepository } from './app-variables';

export const MCP_EGRESS_SETTINGS_NAMESPACE = 'mcp-egress-gateway';
export const MCP_EGRESS_MODE_KEY = 'mode';

export async function getMCPEgressGatewayMode(
  db: Database | TenantScopedDatabase
): Promise<MCPEgressGatewayMode> {
  const raw = await new AppVariableRepository(db as Database).getPlain(
    MCP_EGRESS_SETTINGS_NAMESPACE,
    MCP_EGRESS_MODE_KEY
  );
  return MCP_EGRESS_GATEWAY_MODES.includes(raw as MCPEgressGatewayMode)
    ? (raw as MCPEgressGatewayMode)
    : 'off';
}

export async function setMCPEgressGatewayMode(
  db: Database | TenantScopedDatabase,
  mode: MCPEgressGatewayMode,
  updatedBy?: string
): Promise<void> {
  if (!MCP_EGRESS_GATEWAY_MODES.includes(mode)) throw new Error('Invalid MCP egress gateway mode');
  await new AppVariableRepository(db as Database).set({
    namespace: MCP_EGRESS_SETTINGS_NAMESPACE,
    key: MCP_EGRESS_MODE_KEY,
    value: mode,
    content_type: 'text/plain',
    updated_by: updatedBy as import('../../types').UserID | undefined,
  });
}
