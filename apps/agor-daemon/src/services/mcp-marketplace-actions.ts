import type { MCPServerRepository } from '@agor/core/db';
import { BadRequest, Conflict, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  MCPMarketplaceRemoveServerData,
  MCPMarketplaceRemoveServerResult,
  MCPMarketplaceToolPermissionData,
  MCPMarketplaceToolPermissionResult,
  MCPServerID,
  UserID,
} from '@agor/core/types';

function caller(params?: AuthenticatedParams): UserID {
  const userId = params?.user?.user_id as UserID | undefined;
  if (!userId) throw new NotAuthenticated('Authentication required');
  return userId;
}

/** Marketplace-only CAS removal. Ordinary MCP remove is deliberately bypassed. */
export class MCPMarketplaceRemoveServerService {
  constructor(private readonly repository: MCPServerRepository) {}

  async create(
    data: MCPMarketplaceRemoveServerData,
    params?: AuthenticatedParams
  ): Promise<MCPMarketplaceRemoveServerResult> {
    const userId = caller(params);
    if (!data?.mcp_server_id) throw new BadRequest('mcp_server_id is required');
    if (!(await this.repository.isOwnedBy(data.mcp_server_id, userId))) {
      // Admins do not gain another user's Marketplace inventory. Keep the
      // response indistinguishable from a missing row.
      throw new NotFound('MCP server not found');
    }
    if (!(await this.repository.deleteIfUnattached(data.mcp_server_id))) {
      throw new Conflict(
        'This server was attached to a session while removal was pending. Detach it and retry.'
      );
    }
    return { mcp_server_id: data.mcp_server_id as MCPServerID, removed: true };
  }
}

/** Atomic one-tool mutation; accepts no auth, endpoint, or whole policy object. */
export class MCPMarketplaceToolPermissionService {
  constructor(private readonly repository: MCPServerRepository) {}

  async create(
    data: MCPMarketplaceToolPermissionData,
    params?: AuthenticatedParams
  ): Promise<MCPMarketplaceToolPermissionResult> {
    const userId = caller(params);
    if (!data?.mcp_server_id) throw new BadRequest('mcp_server_id is required');
    if (
      typeof data.tool_name !== 'string' ||
      !data.tool_name.trim() ||
      data.tool_name.length > 512
    ) {
      throw new BadRequest('tool_name must be a non-empty string of at most 512 characters');
    }
    if (typeof data.enabled !== 'boolean') throw new BadRequest('enabled must be boolean');
    const changed = await this.repository.setOwnedToolEnabled(
      data.mcp_server_id,
      userId,
      data.tool_name,
      data.enabled
    );
    if (!changed) throw new NotFound('MCP server not found');
    return {
      mcp_server_id: data.mcp_server_id as MCPServerID,
      tool_name: data.tool_name,
      permission: data.enabled ? 'default' : 'deny',
    };
  }
}
