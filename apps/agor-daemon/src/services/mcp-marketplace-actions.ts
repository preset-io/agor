import {
  MCPServerRepository,
  resolveMcpMemberPolicyForUpdate,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, Conflict, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  MCPMarketplaceRemoveServerData,
  MCPMarketplaceRemoveServerResult,
  MCPMarketplaceToolPermissionData,
  MCPMarketplaceToolPermissionResult,
  UserID,
} from '@agor/core/types';
import { authorizeMcpServerWrite } from '../utils/mcp-server-authorization.js';

type MarketplaceMutationInvalidator = (
  userIds: readonly UserID[],
  params: AuthenticatedParams
) => void;

function caller(params?: AuthenticatedParams): UserID {
  const userId = params?.user?.user_id as UserID | undefined;
  if (!userId) throw new NotAuthenticated('Authentication required');
  return userId;
}

/** Marketplace-only CAS removal. Ordinary MCP remove is deliberately bypassed. */
export class MCPMarketplaceRemoveServerService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly invalidate: MarketplaceMutationInvalidator = () => undefined
  ) {}

  async create(
    data: MCPMarketplaceRemoveServerData,
    params?: AuthenticatedParams
  ): Promise<MCPMarketplaceRemoveServerResult> {
    const userId = caller(params);
    if (!data?.mcp_server_id) throw new BadRequest('mcp_server_id is required');
    const existing = await runWithTenantDatabaseTransaction(
      this.db,
      params?.tenant?.tenant_id,
      async (operationDb) => {
        const freshUser = await new UsersRepository(
          operationDb
        ).getWriteAuthorityProjectionForUpdate(userId);
        if (!freshUser) throw new NotAuthenticated('Authentication is no longer current');
        await resolveMcpMemberPolicyForUpdate(operationDb, userId, params?.tenant?.tenant_id);
        const repository = new MCPServerRepository(operationDb);
        const server = await repository.getWriteAuthorityProjectionForUpdate(data.mcp_server_id);
        if (!server) throw new NotFound('MCP server not found');
        const currentParams = {
          ...params,
          user: { ...params?.user, user_id: freshUser.user_id, role: freshUser.role },
        } as AuthenticatedParams;
        await authorizeMcpServerWrite(operationDb, currentParams, {
          method: 'remove',
          existing: server,
        });
        if (!(await repository.deleteIfUnattachedInCurrentTransaction(server.mcp_server_id))) {
          throw new Conflict(
            'This server was attached to a session while removal was pending. Detach it and retry.'
          );
        }
        return server;
      }
    );
    this.invalidate(
      [...new Set([userId, existing.owner_user_id].filter(Boolean) as UserID[])],
      params!
    );
    return { mcp_server_id: existing.mcp_server_id, removed: true };
  }
}

/** Atomic one-tool mutation; accepts no auth, endpoint, or whole policy object. */
export class MCPMarketplaceToolPermissionService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly invalidate: MarketplaceMutationInvalidator = () => undefined
  ) {}

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
    const existing = await runWithTenantDatabaseTransaction(
      this.db,
      params?.tenant?.tenant_id,
      async (operationDb) => {
        const freshUser = await new UsersRepository(
          operationDb
        ).getWriteAuthorityProjectionForUpdate(userId);
        if (!freshUser) throw new NotAuthenticated('Authentication is no longer current');
        await resolveMcpMemberPolicyForUpdate(operationDb, userId, params?.tenant?.tenant_id);
        const repository = new MCPServerRepository(operationDb);
        const server = await repository.getWriteAuthorityProjectionForUpdate(data.mcp_server_id);
        if (!server) throw new NotFound('MCP server not found');
        const currentParams = {
          ...params,
          user: { ...params?.user, user_id: freshUser.user_id, role: freshUser.role },
        } as AuthenticatedParams;
        await authorizeMcpServerWrite(operationDb, currentParams, {
          method: 'patch',
          existing: server,
          data: {},
        });
        const changed = await repository.setToolEnabledInCurrentTransaction(
          server.mcp_server_id,
          data.tool_name,
          data.enabled
        );
        if (!changed) throw new NotFound('MCP server not found');
        return server;
      }
    );
    this.invalidate(
      [...new Set([userId, existing.owner_user_id].filter(Boolean) as UserID[])],
      params!
    );
    return {
      mcp_server_id: existing.mcp_server_id,
      tool_name: data.tool_name,
      permission: data.enabled ? 'default' : 'deny',
    };
  }
}
