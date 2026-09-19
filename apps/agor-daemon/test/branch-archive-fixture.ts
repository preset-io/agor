import { once } from 'node:events';
import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import { BadRequest, feathers, feathersExpress, NotAuthenticated } from '@agor/core/feathers';
import type { BranchID, HookContext, Params } from '@agor/core/types';
import { isBranchArchiveOrDeleteOptions, ROLES } from '@agor/core/types';
import express from 'express';
import { setupMCPRoutes } from '../src/mcp/server.js';
import { BranchesService } from '../src/services/branches.js';
import { SessionsService } from '../src/services/sessions.js';
import { createUsersService } from '../src/services/users.js';
import { requireMinimumRole } from '../src/utils/authorization.js';
import { authorizeBranchArchiveDelete } from '../src/utils/branch-archive-delete-authorization.js';
import {
  createTenantDatabaseScopeAroundHook,
  createTenantWriteAdmissionAroundHook,
} from '../src/utils/tenant-db-scope.js';

/** Disposable HTTP MCP + real Feathers/service/repository boundary; never a running daemon. */
export async function archiveMcpFixture(db: Database, hosted = false) {
  const guarded = createTenantScopedDatabaseProxy(db, {
    requireScope: true,
    label: 'archive fixture',
  });
  const app = feathersExpress(feathers());
  const config: AgorConfig = {
    multi_tenancy: hosted
      ? { mode: 'required_from_auth', trusted_header: 'x-agor-tenant-id' }
      : undefined,
  };
  const jwtSecret = 'disposable-archive-mcp-fixture';
  app.set('config', config);
  app.set('authentication', { secret: jwtSecret });
  app.use(express.json());
  const service = new BranchesService(guarded, app);
  app.use('branches', service);
  app.use('sessions', new SessionsService(guarded, app));
  app.use('users', createUsersService(guarded));
  const tenantHook = (transaction = true) =>
    createTenantDatabaseScopeAroundHook({ db: guarded, config, jwtSecret, transaction });
  for (const path of ['branches', 'sessions', 'users']) {
    app.service(path).hooks({ around: { all: [tenantHook()] } });
  }
  // Compose the thin route adapter with production tenant/role/archive-authorization hooks.
  // Unlike register-routes.ts, this duplicates registration, substitutes a minimal
  // authenticated-user assertion for requireAuth, and omits ordinary service hooks
  // from register-hooks.ts. It tests MCP-to-service behavior, not production wiring;
  // registration/hook changes can therefore regress independently of this fixture.
  // MCP authentication is real (a persisted, hashed personal key), not a params stub.
  const route = '/branches/:id/archive-or-delete';
  app.use(route, {
    async create(data: unknown, params: Params) {
      if (!isBranchArchiveOrDeleteOptions(data))
        throw new BadRequest('Invalid branch archive/delete options');
      return service.archiveOrDelete(params.route!.id as BranchID, data, params);
    },
  });
  app.service(route).hooks({
    around: { all: [tenantHook(false), createTenantWriteAdmissionAroundHook(guarded)] },
    before: {
      create: [
        async (context: HookContext) => {
          if (!context.params.authenticated || !context.params.user) throw new NotAuthenticated();
        },
        requireMinimumRole(ROLES.MEMBER, 'archive or delete branches'),
        (context: HookContext) =>
          runWithTenantDatabaseScope(guarded, context.params.tenant?.tenant_id, () =>
            authorizeBranchArchiveDelete(context, {
              branchRepository: new BranchRepository(guarded),
            })
          ),
      ],
    },
  });
  setupMCPRoutes(app, guarded, true, config);
  const server = await app.listen(0, '127.0.0.1');
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listen address');
  return {
    app,
    service,
    async call(
      key: string,
      name: string,
      args: Record<string, unknown>,
      facade = false,
      tenant?: string
    ) {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-API-Key': key,
          ...(tenant ? { 'X-Agor-Tenant-Id': tenant } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: facade
            ? { name: 'agor_execute_tool', arguments: { tool_name: name, arguments: args } }
            : { name, arguments: args },
        }),
      });
      const body = await response.text();
      const data = JSON.parse(
        body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6) ?? body
      );
      return { status: response.status, ...data } as {
        status: number;
        result?: { isError?: boolean; content: Array<{ text: string }> };
        error?: { message: string };
      };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}
