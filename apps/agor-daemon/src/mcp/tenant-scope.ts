import type { TenantScopeAwareDatabase, TenantScopedDatabase } from '@agor/core/db';
import {
  assertTenantWritable,
  bindRepositoryToTenantUnitOfWork,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  TenantWriteGateActiveError,
} from '@agor/core/db';
import { Unavailable } from '@agor/core/feathers';
import type { McpServer } from '@modelcontextprotocol/server';
import { wrapRegisterTool } from './register-tool-proxy.js';
import type { McpContext } from './server.js';

/**
 * Custom MCP service methods bypass the Feathers around hooks that normally
 * enter the tenant database scope. Re-enter that scope when authentication
 * supplied a tenant, while preserving static/single-tenant behavior.
 *
 * READ-ONLY variant. For custom-method calls that MUTATE tenant data, use
 * {@link runWithMcpTenantDatabaseWrite} so the tenant write-freeze gate is
 * enforced too — otherwise MCP mutations would slip past the freeze that HTTP
 * custom routes apply via `tenantWriteGateAround`.
 */
export async function runWithMcpTenantDatabaseScope<T>(
  ctx: McpContext,
  work: (db: TenantScopeAwareDatabase) => Promise<T>
): Promise<T> {
  const tenantId = ctx.baseServiceParams.tenant?.tenant_id;
  if (!tenantId) return work(ctx.db);
  return runWithTenantDatabaseScope(ctx.db, tenantId, () => work(ctx.db));
}

/**
 * Open one short, positively tenant-bound database unit for helpers whose type
 * contract requires a {@link TenantScopedDatabase}. Unlike the compatibility
 * wrapper above, this cannot fall back to an unscoped handle when MCP tenant
 * identity is absent.
 */
export async function runWithMcpTenantDatabaseUnit<T>(
  ctx: McpContext,
  work: (db: TenantScopedDatabase) => Promise<T>
): Promise<T> {
  const tenantId = ctx.baseServiceParams.tenant?.tenant_id;
  if (!tenantId) throw new Error('MCP tenant database unit requires tenant identity');
  return runWithTenantDatabaseScope(ctx.db, tenantId, work);
}

/**
 * MUTATING variant of {@link runWithMcpTenantDatabaseScope}. Mirrors the HTTP
 * custom-route pair `[tenantDatabaseScopeAround, tenantWriteGateAround]`: it
 * enters the tenant database scope AND asserts the tenant write-freeze gate
 * inside it before running the mutation, translating `TenantWriteGateActiveError`
 * to `Unavailable` exactly like the route hook. Use this for MCP calls to custom
 * (non-transport) service methods that write `this.db` directly — those bypass
 * the Feathers `writeGateBefore` hook that guards standard methods.
 *
 * On SQLite/static the gate read is a no-op (`readTenantWriteGate` short-circuits
 * for non-Postgres), so behavior there is identical to the read-only variant.
 */
export async function runWithMcpTenantDatabaseWrite<T>(
  ctx: McpContext,
  work: (db: TenantScopeAwareDatabase) => Promise<T>
): Promise<T> {
  const tenantId = ctx.baseServiceParams.tenant?.tenant_id;
  if (!tenantId) return work(ctx.db);
  return runWithTenantDatabaseScope(ctx.db, tenantId, async () => {
    try {
      await assertTenantWritable(ctx.db, tenantId);
    } catch (error) {
      if (error instanceof TenantWriteGateActiveError) {
        throw new Unavailable(error.message);
      }
      throw error;
    }
    return work(ctx.db);
  });
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
