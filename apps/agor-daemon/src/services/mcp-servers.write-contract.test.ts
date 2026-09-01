import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { createDatabaseAsync, MCPServerRepository, runMigrations } from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { AuthenticatedParams, MCPAuth, MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { redactMCPServerSecretFields, validateMcpServerWriteInput } from '../register-hooks.js';
import { createMCPServersService } from './mcp-servers.js';

const externalParams = (provider: 'rest' | 'socketio') =>
  ({
    provider,
    authenticated: true,
    user: { user_id: 'user-1', role: 'admin' },
  }) as unknown as AuthenticatedParams;

async function buildService() {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const repository = new MCPServerRepository(rawDb);
  const app = feathers();
  app.use('mcp-servers', createMCPServersService(rawDb as unknown as TenantScopeAwareDatabase));
  app.service('mcp-servers').hooks({
    before: {
      create: [(context) => validateMcpServerWriteInput(context, true)],
      patch: [(context) => validateMcpServerWriteInput(context, false)],
      update: [(context) => validateMcpServerWriteInput(context, false)],
    },
    after: {
      create: [redactMCPServerSecretFields],
      patch: [redactMCPServerSecretFields],
      update: [redactMCPServerSecretFields],
    },
  } as never);
  return { app, repository };
}

const createInput = (auth: MCPAuth) => ({
  name: `server-${auth.type}`,
  transport: 'http' as const,
  url: 'https://mcp.example.test/mcp',
  auth,
  scope: 'global' as const,
  enabled: true,
});

describe('MCP server public write contract', () => {
  it.each(['rest', 'socketio'] as const)(
    'rejects server-owned and unknown top-level CREATE/PUT fields in %s provider-hook units',
    async (provider) => {
      const { app } = await buildService();
      const params = externalParams(provider);

      for (const field of [
        'mcp_server_id',
        'created_at',
        'updated_at',
        'config_version',
        'runtime_generation',
        'mcp_runtime',
      ]) {
        await expect(
          app
            .service('mcp-servers')
            .create({ ...createInput({ type: 'none' }), [field]: Number.MAX_SAFE_INTEGER }, params)
        ).rejects.toThrow(`Unknown MCP server field: ${field}`);
      }

      const stored = await app.service('mcp-servers').create(createInput({ type: 'none' }), params);
      await expect(
        app
          .service('mcp-servers')
          .update(
            stored.mcp_server_id,
            { display_name: 'forged', owner_user_id: 'user-2' } as never,
            params
          )
      ).rejects.toThrow('Unknown MCP server field: owner_user_id');
      for (const field of ['mcp_server_id', 'created_at', 'config_version', 'tools']) {
        await expect(
          app
            .service('mcp-servers')
            .update(stored.mcp_server_id, { display_name: 'forged', [field]: [] } as never, params)
        ).rejects.toThrow(`Unknown MCP server field: ${field}`);
      }
    }
  );

  it.each(['rest', 'socketio'] as const)(
    'rejects CREATE sentinels and unknown nested auth fields in %s provider-hook units',
    async (provider) => {
      const { app, repository } = await buildService();
      const params = externalParams(provider);

      await expect(
        app
          .service('mcp-servers')
          .create(createInput({ type: 'bearer', token: MCP_HEADER_REDACTED_SENTINEL }), params)
      ).rejects.toThrow(/redaction sentinel on create/);
      await expect(
        app
          .service('mcp-servers')
          .create(
            createInput({ type: 'oauth', oauth_client_secret_typo: 'secret' } as never),
            params
          )
      ).rejects.toThrow('Unknown auth field: oauth_client_secret_typo');
      expect(await repository.findAll()).toHaveLength(0);
    }
  );

  it('normalizes CREATE auth:null to an absent auth object', async () => {
    const { app, repository } = await buildService();
    const created = await app
      .service('mcp-servers')
      .create({ ...createInput({ type: 'none' }), auth: null } as never, externalParams('rest'));
    expect(created.auth).toBeUndefined();
    expect((await repository.findById(created.mcp_server_id))?.auth).toBeUndefined();
  });

  it.each([
    {
      label: 'bearer',
      auth: { type: 'bearer', token: 'bearer-secret' } as MCPAuth,
      replacement: { type: 'bearer', token: MCP_HEADER_REDACTED_SENTINEL },
      secret: 'bearer-secret',
      field: 'token',
    },
    {
      label: 'JWT',
      auth: {
        type: 'jwt',
        api_url: 'https://auth.example.test/token',
        api_token: 'jwt-token',
        api_secret: 'jwt-secret',
      } as MCPAuth,
      replacement: {
        type: 'jwt',
        api_url: 'https://auth.example.test/token',
        api_token: MCP_HEADER_REDACTED_SENTINEL,
        api_secret: MCP_HEADER_REDACTED_SENTINEL,
      },
      secret: 'jwt-secret',
      field: 'api_secret',
    },
    {
      label: 'OAuth',
      auth: {
        type: 'oauth',
        oauth_scope: 'old-scope',
        oauth_client_secret: 'oauth-secret',
        oauth_access_token: 'oauth-access',
        oauth_refresh_token: 'oauth-refresh',
      } as MCPAuth,
      replacement: {
        type: 'oauth',
        oauth_scope: 'new-scope',
        oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
        oauth_access_token: MCP_HEADER_REDACTED_SENTINEL,
        oauth_refresh_token: MCP_HEADER_REDACTED_SENTINEL,
      },
      secret: 'oauth-secret',
      field: 'oauth_client_secret',
    },
  ])('round-trips redacted $label secrets through PUT without publishing them', async (entry) => {
    const { app, repository } = await buildService();
    const params = externalParams('socketio');
    const created = await repository.create(createInput(entry.auth));
    const events: MCPServer[] = [];
    app
      .service('mcp-servers')
      .on('updated', (_server: MCPServer, hook: { dispatch?: MCPServer; result?: MCPServer }) =>
        events.push((hook.dispatch ?? hook.result) as MCPServer)
      );

    const response = (await app.service('mcp-servers').update(
      created.mcp_server_id,
      {
        display_name: 'PUT result',
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        scope: 'global',
        enabled: true,
        auth: entry.replacement,
      } as never,
      params
    )) as MCPServer;

    const stored = await repository.findById(created.mcp_server_id);
    expect(stored?.auth?.[entry.field as keyof MCPAuth]).toBe(entry.secret);
    expect(response.auth?.[entry.field as keyof MCPAuth]).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(JSON.stringify(response)).not.toContain(entry.secret);
    expect(JSON.stringify(events)).not.toContain(entry.secret);
    if (entry.label === 'JWT') {
      expect(stored?.auth).toMatchObject({ api_url: 'https://auth.example.test/token' });
    }
    if (entry.label === 'OAuth') expect(stored?.auth?.oauth_scope).toBe('new-scope');
  });

  it('preserves explicit field-clear and whole-auth-clear semantics on PATCH/PUT', async () => {
    const { app, repository } = await buildService();
    const params = externalParams('rest');
    const created = await repository.create(
      createInput({ type: 'oauth', oauth_client_id: 'client', oauth_client_secret: 'secret' })
    );

    await app
      .service('mcp-servers')
      .patch(created.mcp_server_id, { auth: { oauth_client_secret: null } }, params);
    expect((await repository.findById(created.mcp_server_id))?.auth).toEqual({
      type: 'oauth',
      oauth_client_id: 'client',
    });

    await app.service('mcp-servers').update(
      created.mcp_server_id,
      {
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        scope: 'global',
        enabled: true,
        auth: null,
      } as never,
      params
    );
    expect((await repository.findById(created.mcp_server_id))?.auth).toBeUndefined();
  });
});
