import { resolveMultiTenancyConfig } from '@agor/core/config';
import { runWithTenantContext, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { AuthenticationService } from '@agor/core/feathers';
import { getOrCreateExecutorConnectionRevocationFence } from '../src/auth/executor-connection-admission.js';
import { RuntimeJWTStrategy } from '../src/auth/runtime-jwt-strategy.js';
import { generateSessionToken, initMcpTokens, shutdownMcpTokens } from '../src/mcp/tokens.js';
import { KnowledgeDocumentsService } from '../src/services/knowledge-documents.js';
import { SessionTokenService } from '../src/services/session-token-service.js';
import { boardMetadataTestApp } from './board-metadata-app.js';
import type { seedQueue } from './task-queue-fixture.js';

/** Real REST JWT authentication, session after-hook issuance and MCP boundary. */
export async function executionTestServer(
  db: TenantScopeAwareDatabase,
  seed: Awaited<ReturnType<typeof seedQueue>>,
  tenantId = 'default',
  postgres = false
) {
  const taskTokens = new SessionTokenService(
    { expiration_ms: 300_000, max_uses: -1 },
    {
      db,
      startCleanupTimer: false,
    }
  );
  const config = {
    database: { dialect: postgres ? ('postgresql' as const) : ('sqlite' as const) },
    multi_tenancy: postgres
      ? {
          mode: 'required_from_auth' as const,
          auth_claim: 'tenant_id',
          filesystem_isolation_enabled: true,
        }
      : { mode: 'static' as const, static_tenant_id: 'default' },
    execution: {},
  };
  const server = await boardMetadataTestApp(db, config, false, true, true, async (app) => {
    app.use('kb/documents', new KnowledgeDocumentsService(db, app));
    const secret = app.get('authentication').secret as string;
    taskTokens.setJwtSecret(secret);
    (app.service('authentication') as unknown as AuthenticationService).register(
      'jwt',
      new RuntimeJWTStrategy({
        sessionTokenService: taskTokens,
        executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
        multiTenancy: resolveMultiTenancyConfig(config),
      })
    );
  });
  initMcpTokens({
    db,
    multiTenancy: resolveMultiTenancyConfig(config),
    taskAuthorityStore: taskTokens,
  });
  const executorToken = await runWithTenantContext(tenantId, () =>
    taskTokens.generateToken(seed.session.session_id, seed.owner.user_id, {
      taskId: seed.active.task_id,
      branchId: seed.branch.branch_id,
    })
  );
  const sessionResponse = await fetch(`${server.url}/sessions/${seed.session.session_id}`, {
    headers: { authorization: `Bearer ${executorToken}` },
  });
  if (!sessionResponse.ok)
    throw new Error(`Executor session fetch failed: ${sessionResponse.status}`);
  const session = (await sessionResponse.json()) as { mcp_token?: string };
  if (!session.mcp_token) throw new Error('Executor MCP credential not issued');
  const ordinaryToken = await runWithTenantContext(tenantId, () =>
    generateSessionToken(server.app, seed.session.session_id, seed.owner.user_id)
  );
  const call = async (
    credential: string,
    name = 'agor_execution_get_current',
    args: Record<string, unknown> = {},
    headers: Record<string, string> = {}
  ) => {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    const body = JSON.parse(
      text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? text
    ) as {
      result?: { isError?: boolean; content: Array<{ type: string; text: string }> };
      error?: unknown;
    };
    return { status: response.status, ...body };
  };
  return {
    ...server,
    taskTokens,
    executorToken,
    mcpToken: session.mcp_token,
    ordinaryToken,
    call,
    async close() {
      shutdownMcpTokens();
      await server.close();
    },
  };
}
