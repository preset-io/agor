import {
  MCPServerRepository,
  resolveMcpMemberPolicyForUpdate,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
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
  params: AuthenticatedParams,
  serverId: string
) => void | Promise<void>;

function caller(params?: AuthenticatedParams): UserID {
  const userId = params?.user?.user_id as UserID | undefined;
  if (!userId) throw new NotAuthenticated('Authentication required');
  return userId;
}

function notifyMarketplaceMutation(
  invalidate: MarketplaceMutationInvalidator,
  userIds: readonly UserID[],
  params: AuthenticatedParams,
  serverId: string
): void {
  try {
    void Promise.resolve(invalidate(userIds, params, serverId)).catch(() => {
      console.warn('[MCP Runtime] event=marketplace_hint_failed code=async_failure');
    });
  } catch {
    console.warn('[MCP Runtime] event=marketplace_hint_failed code=sync_failure');
  }
}

/** Count-confirmed removal serialized with attachment through the parent row lock. */
export class MCPMarketplaceRemoveServerService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly invalidate: MarketplaceMutationInvalidator = () => undefined,
    private readonly removeServer: (
      db: TenantScopedDatabase,
      id: string,
      params: AuthenticatedParams
    ) => Promise<unknown> = (db, id) => new MCPServerRepository(db).delete(id)
  ) {}

  async create(
    data: MCPMarketplaceRemoveServerData,
    params?: AuthenticatedParams
  ): Promise<MCPMarketplaceRemoveServerResult> {
    const userId = caller(params);
    if (!data?.mcp_server_id) throw new BadRequest('mcp_server_id is required');
    if (data.detach !== undefined && typeof data.detach !== 'boolean') {
      throw new BadRequest('detach must be boolean');
    }
    if (
      data.detach &&
      (!Number.isSafeInteger(data.expected_session_count) || data.expected_session_count! < 0)
    ) {
      throw new BadRequest('expected_session_count is required for delete and detach');
    }
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
        const count = await repository.countSessionAttachments(server.mcp_server_id);
        if (count !== (data.detach ? data.expected_session_count : 0)) {
          throw new Conflict(
            'Session attachments changed. Review the current count and confirm deletion again.'
          );
        }
        // The FK cascade removes links and grants in the same transaction. A
        // concurrent attachment either precedes this lock/count or fails its FK
        // after deletion; it cannot leave a dangling link or partially detach.
        await this.removeServer(operationDb, server.mcp_server_id, currentParams);
        return server;
      }
    );
    notifyMarketplaceMutation(
      this.invalidate,
      [...new Set([userId, existing.owner_user_id].filter(Boolean) as UserID[])],
      params!,
      existing.mcp_server_id
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
    notifyMarketplaceMutation(
      this.invalidate,
      [...new Set([userId, existing.owner_user_id].filter(Boolean) as UserID[])],
      params!,
      existing.mcp_server_id
    );
    return {
      mcp_server_id: existing.mcp_server_id,
      tool_name: data.tool_name,
      permission: data.enabled ? 'default' : 'deny',
    };
  }
}
