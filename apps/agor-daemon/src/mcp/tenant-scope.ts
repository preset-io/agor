import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  bindRepositoryToTenantUnitOfWork,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wrapRegisterTool } from './register-tool-proxy.js';
import type { McpContext } from './server.js';

/**
 * Custom MCP service methods bypass the Feathers around hooks that normally
 * enter the tenant database scope. Re-enter that scope when authentication
 * supplied a tenant, while preserving static/single-tenant behavior.
 */
export async function runWithMcpTenantDatabaseScope<T>(
  ctx: McpContext,
  work: (db: TenantScopeAwareDatabase) => Promise<T>
): Promise<T> {
  const tenantId = ctx.baseServiceParams.tenant?.tenant_id;
  if (!tenantId) return work(ctx.db);
  return runWithTenantDatabaseScope(ctx.db, tenantId, () => work(ctx.db));
}

/** Bind a repository used by long MCP orchestration to short tenant DB units. */
export function bindMcpRepositoryToTenantUnitOfWork<T extends object>(
  ctx: McpContext,
  create: (db: TenantScopeAwareDatabase) => T
): T {
  return bindRepositoryToTenantUnitOfWork(ctx.db, create(ctx.db));
}

/**
 * Enter the authenticated tenant scope once at the MCP tool invocation boundary.
 *
 * Tool implementations can then use repositories and custom service methods just
 * like normal Feathers requests: tenant identity is ambient for the complete
 * synchronous/async operation rather than manually threaded through each call.
 */
export function tenantScopedToolProxy(server: McpServer, ctx: McpContext): McpServer {
  return wrapRegisterTool(server, (register, name, config, handler) =>
    register(name, config, (args, extra) => {
      const tenantId = ctx.baseServiceParams.tenant?.tenant_id;
      const invoke = () => Promise.resolve(handler(args, extra));
      return tenantId ? runWithTenantContext(tenantId, invoke) : invoke();
    })
  );
}
