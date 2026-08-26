import type { Server } from 'node:http';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  shortId,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import {
  errorHandler,
  feathers,
  feathersExpress,
  NotAuthenticated,
  rest,
  socketio,
  socketioClient,
} from '@agor/core/feathers';
import { mcpServerQueryValidator, typedValidateQuery } from '@agor/core/lib/feathers-validation';
import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { HookContext, MCPAuth, MCPServer, MCPServerID } from '@agor/core/types';
import { type Socket as ClientSocket, io as createSocketClient } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactMCPServerSecretFields, validateMcpServerWriteInput } from '../register-hooks.js';
import { type RegisterServicesContext, registerMCPServices } from '../register-services.js';
import { createMCPServersService } from './mcp-servers.js';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const AUTH_TOKEN = 'mcp-write-contract-token';

type Client = ReturnType<typeof feathers> & { io?: ClientSocket };

interface Harness {
  baseUrl: string;
  repository: MCPServerRepository;
  client: Client;
  socket: ClientSocket;
  grants: UserMCPOAuthTokenRepository;
  close(): Promise<void>;
}

interface CoordinatorProbe {
  pendingServerIds: Set<string>;
  invalidatedServerIds: string[];
  lockServerIds: string[];
}

function waitForSocket(socket: ClientSocket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

async function createHarness(
  token = AUTH_TOKEN,
  coordinatorProbe?: CoordinatorProbe,
  mcpOutboundDnsLookup?: RegisterServicesContext['mcpOutboundDnsLookup']
): Promise<Harness> {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const repository = new MCPServerRepository(rawDb);
  const app = feathersExpress(feathers());
  app.use(feathersExpress.json());
  app.configure(rest());
  app.configure(
    socketio({}, (io) => {
      io.on('connection', (socket) => {
        if (socket.handshake.auth.token === AUTH_TOKEN) {
          socket.feathers.user = { user_id: USER_ID, role: 'admin' };
          socket.feathers.tenant = { tenant_id: 'default', source: 'static' };
          app.channel('authenticated').join(socket.feathers as never);
        }
      });
    })
  );
  const requireAuth = (context: HookContext): HookContext => {
    const bearer = context.params.headers?.authorization;
    const restAuthenticated = bearer === `Bearer ${AUTH_TOKEN}`;
    const socketUser = context.params.user ?? context.params.connection?.user;
    if (context.params.provider && !restAuthenticated && !socketUser) {
      throw new NotAuthenticated('Authentication required');
    }
    context.params.user = socketUser ?? ({ user_id: USER_ID, role: 'admin' } as never);
    context.params.tenant =
      context.params.tenant ?? ({ tenant_id: 'default', source: 'static' } as never);
    return context;
  };
  if (coordinatorProbe || mcpOutboundDnsLookup) {
    await registerMCPServices({
      db: rawDb as unknown as TenantScopeAwareDatabase,
      app: app as never,
      config: {} as RegisterServicesContext['config'],
      jwtSecret: 'transport-contract-jwt',
      daemonUrl: 'http://127.0.0.1:3030',
      bundledUiAvailable: false,
      DAEMON_PORT: 3030,
      UI_PORT: 5173,
      allowSuperadmin: false,
      requireAuth: async (context) => requireAuth(context),
      deployment: {} as RegisterServicesContext['deployment'],
      ...(coordinatorProbe
        ? {
            mcpOAuthPendingFlowAuthority: {
              invalidateForServer: async (_tenantId: string, serverId: MCPServerID) => {
                if (!coordinatorProbe.pendingServerIds.delete(serverId)) return 0;
                coordinatorProbe.invalidatedServerIds.push(serverId);
                return 1;
              },
              maintain: async () => undefined,
            } as unknown as NonNullable<RegisterServicesContext['mcpOAuthPendingFlowAuthority']>,
            lockMcpOAuthGrantConfiguration: async (_db, _tenantId, serverId) => {
              coordinatorProbe.lockServerIds.push(serverId);
            },
          }
        : {}),
      mcpOutboundDnsLookup,
    });
  } else {
    app.use('mcp-servers', createMCPServersService(rawDb as unknown as TenantScopeAwareDatabase));
  }
  app.service('mcp-servers').hooks({
    before: {
      all: [requireAuth, typedValidateQuery(mcpServerQueryValidator)],
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
  app.service('mcp-servers').publish(() => app.channel('authenticated'));
  app.use(errorHandler());

  const server = (await app.listen(0, '127.0.0.1')) as Server;
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected MCP test listener');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const socket = createSocketClient(baseUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  const client = feathers() as Client;
  client.configure(socketioClient(socket));
  await waitForSocket(socket);

  return {
    baseUrl,
    repository,
    grants: new UserMCPOAuthTokenRepository(rawDb),
    client,
    socket,
    close: async () => {
      socket.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      (rawDb as unknown as { $client?: { close(): void } }).$client?.close();
    },
  };
}

function createInput(auth: MCPAuth = { type: 'none' }) {
  return {
    name: 'transport-contract',
    display_name: 'Transport Contract',
    transport: 'http' as const,
    url: 'https://mcp.example.test/mcp',
    auth,
    scope: 'global' as const,
    enabled: true,
  };
}

async function restWrite(
  harness: Harness,
  method: 'POST' | 'PUT' | 'PATCH',
  data: unknown,
  id?: string,
  authenticated = true
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.baseUrl}/mcp-servers${id ? `/${id}` : ''}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify(data),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const invalidCreates: Array<{ label: string; value: Record<string, unknown>; error: RegExp }> = [
  { label: 'caller ID', value: { mcp_server_id: USER_ID }, error: /mcp_server_id/ },
  { label: 'timestamp', value: { created_at: new Date().toISOString() }, error: /created_at/ },
  { label: 'runtime state', value: { mcp_runtime: {} }, error: /mcp_runtime/ },
  { label: 'runtime revision', value: { config_version: 2 }, error: /config_version/ },
  { label: 'source', value: { source: 'catalog' }, error: /source/ },
  { label: 'import path', value: { import_path: '/tmp/secret' }, error: /import_path/ },
  { label: 'catalog stamp', value: { catalog_entry_name: 'forged' }, error: /catalog_entry_name/ },
  { label: 'transport enum', value: { transport: 'websocket' }, error: /transport must be/ },
  { label: 'remote URL', value: { url: undefined }, error: /url is required/ },
  {
    label: 'stdio command',
    value: { transport: 'stdio', url: undefined, command: undefined },
    error: /command is required/,
  },
  { label: 'scope enum', value: { scope: 'tenant' }, error: /scope must be/ },
  { label: 'enabled shape', value: { enabled: 'yes' }, error: /enabled must be boolean/ },
  { label: 'args shape', value: { args: ['ok', 1] }, error: /args must contain/ },
  { label: 'env shape', value: { env: { 'BAD-NAME': 'secret' } }, error: /environment variable/ },
  {
    label: 'headers shape',
    value: { headers: { Authorization: 'secret' } },
    error: /not an allowed/,
  },
  { label: 'name shape', value: { name: 7 }, error: /name must be a string/ },
  { label: 'URL protocol', value: { url: 'javascript:alert(1)' }, error: /HTTP\(S\)/ },
  {
    label: 'unmatched opening header template',
    value: { headers: { 'X-Secret': 'sentinel{{' } },
    error: /unbalanced template delimiter/,
  },
  {
    label: 'unmatched closing env template',
    value: { env: { MCP_SECRET: 'sentinel}}' } },
    error: /unbalanced template delimiter/,
  },
  {
    label: 'unmatched bearer template',
    value: { auth: { type: 'bearer', token: 'sentinel{{' } },
    error: /unbalanced template delimiter/,
  },
  {
    label: 'arbitrary URL template',
    value: { url: 'https://mcp.example.test/{{ lookup user.env "TARGET" }}' },
    error: /only user\.env templates/,
  },
  {
    label: 'embedded URL credentials',
    value: { url: 'https://user:pass@mcp.example.test' },
    error: /embedded credentials/,
  },
  {
    label: 'header sentinel',
    value: { headers: { 'X-Secret': MCP_HEADER_REDACTED_SENTINEL } },
    error: /redaction sentinel on create/,
  },
  {
    label: 'env sentinel',
    value: { env: { MCP_SECRET: MCP_HEADER_REDACTED_SENTINEL } },
    error: /redaction sentinel on create/,
  },
  {
    label: 'unknown auth key',
    value: { auth: { type: 'oauth', oauth_client_secert: 'typo' } },
    error: /oauth_client_secert/,
  },
  {
    label: 'bearer sentinel',
    value: { auth: { type: 'bearer', token: MCP_HEADER_REDACTED_SENTINEL } },
    error: /redaction sentinel on create/,
  },
  {
    label: 'missing bearer token',
    value: { auth: { type: 'bearer' } },
    error: /auth\.token is required/,
  },
  {
    label: 'missing JWT fields',
    value: { auth: { type: 'jwt' } },
    error: /auth\.api_url is required/,
  },
  {
    label: 'JWT sentinel',
    value: { auth: { type: 'jwt', api_secret: MCP_HEADER_REDACTED_SENTINEL } },
    error: /redaction sentinel on create/,
  },
  {
    label: 'OAuth sentinel',
    value: {
      auth: { type: 'oauth', oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL },
    },
    error: /redaction sentinel on create/,
  },
  {
    label: 'wrong auth mode',
    value: { auth: { type: 'none', token: 'must-not-persist' } },
    error: /does not apply/,
  },
  {
    label: 'OAuth enum',
    value: { auth: { type: 'oauth', oauth_mode: 'workspace' } },
    error: /oauth_mode/,
  },
  {
    label: 'OAuth expiry range',
    value: { auth: { type: 'oauth', oauth_token_expires_at: Number.MAX_SAFE_INTEGER + 1 } },
    error: /safe integer/,
  },
  {
    label: 'auth URL protocol',
    value: { auth: { type: 'jwt', api_url: 'file:///tmp/token' } },
    error: /HTTP\(S\)/,
  },
  {
    label: 'arbitrary auth URL template',
    value: { auth: { type: 'jwt', api_url: 'https://{{ lookup user.env "HOST" }}' } },
    error: /only user\.env templates/,
  },
  {
    label: 'stdio remote fields',
    value: { transport: 'stdio', command: 'node', url: 'https://mcp.example.test' },
    error: /does not apply to stdio/,
  },
];

describe('MCP server real REST and Socket.IO write contract', () => {
  it.each(['REST'] as const)(
    'sanitizes secret-bearing JWT DNS/provider exceptions over %s',
    async (transport) => {
      const sentinel = `SENTINEL_${transport}_JWT_DNS_84a1`;
      const harness = await createHarness(AUTH_TOKEN, undefined, async () => {
        throw Object.assign(new Error(`lookup failed for https://${sentinel}.example.test`), {
          code: 'ENOTFOUND',
        });
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const realtimeSpy = vi.fn();
      for (const event of ['created', 'updated', 'patched', 'removed'] as const) {
        harness.client.service('mcp-servers').on(event, realtimeSpy);
      }
      try {
        const payload = {
          api_url: 'https://auth.example.test/token',
          api_token: 'configured-token',
          api_secret: sentinel,
        };
        const result =
          transport === 'REST'
            ? await fetch(`${harness.baseUrl}/mcp-servers/test-jwt`, {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${AUTH_TOKEN}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify(payload),
              }).then((response) => response.json())
            : await harness.client.service('mcp-servers/test-jwt').create(payload);

        expect(result).toMatchObject({ success: false, category: 'provider_unavailable' });
        expect(JSON.stringify(result)).not.toContain(sentinel);
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sentinel);
        expect(JSON.stringify(await harness.repository.findAll())).not.toContain(sentinel);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(JSON.stringify(realtimeSpy.mock.calls)).not.toContain(sentinel);
        expect(realtimeSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        await harness.close();
      }
    }
  );
  const harnesses: Harness[] = [];
  afterEach(async () => {
    while (harnesses.length) await harnesses.pop()!.close();
  });

  it.each(['REST', 'Socket.IO'] as const)(
    'authenticates %s before parsing a deliberately invalid write',
    async (transport) => {
      const harness = await createHarness(transport === 'Socket.IO' ? 'wrong-token' : AUTH_TOKEN);
      harnesses.push(harness);
      const invalid = { ...createInput(), source: 'catalog' };
      if (transport === 'REST') {
        const response = await restWrite(harness, 'POST', invalid, undefined, false);
        expect(response.status).toBe(401);
        expect(JSON.stringify(response.body)).not.toContain('Unknown MCP server field');
      } else {
        await expect(harness.client.service('mcp-servers').create(invalid)).rejects.toThrow(
          /Authentication required/
        );
      }
      expect(await harness.repository.findAll()).toEqual([]);
    }
  );

  it.each(['REST', 'Socket.IO'] as const)(
    'authenticates %s before parsing an invalid query',
    async (transport) => {
      const harness = await createHarness(transport === 'Socket.IO' ? 'wrong-token' : AUTH_TOKEN);
      harnesses.push(harness);
      if (transport === 'REST') {
        const response = await fetch(`${harness.baseUrl}/mcp-servers?transport=websocket`);
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain('validation');
      } else {
        await expect(
          harness.client.service('mcp-servers').find({
            query: { transport: 'websocket' },
          } as never)
        ).rejects.toThrow(/Authentication required/);
      }
    }
  );

  it.each(['REST', 'Socket.IO'] as const)(
    'rejects every closed CREATE schema violation over real %s transport',
    async (transport) => {
      const harness = await createHarness();
      harnesses.push(harness);
      for (const invalid of invalidCreates) {
        const payload = { ...createInput(), ...invalid.value };
        if (transport === 'REST') {
          const response = await restWrite(harness, 'POST', payload);
          expect(response.status, invalid.label).toBe(400);
          expect(String(response.body.message), invalid.label).toMatch(invalid.error);
        } else {
          await expect(
            harness.client.service('mcp-servers').create(payload),
            invalid.label
          ).rejects.toThrow(invalid.error);
        }
      }
      expect(await harness.repository.findAll()).toEqual([]);
    }
  );

  it.each(['REST', 'Socket.IO'] as const)(
    'rejects malformed PATCH and PUT fields over real %s transport',
    async (transport) => {
      const harness = await createHarness();
      harnesses.push(harness);
      const created = await harness.repository.create(
        createInput({
          type: 'oauth',
          oauth_client_secret: 'stored-secret',
        })
      );
      const invalidMutations = [
        { data: { source: 'catalog' }, error: /source/ },
        { data: { import_path: '/tmp/forged' }, error: /import_path/ },
        { data: { catalog_entry_name: 'forged' }, error: /catalog_entry_name/ },
        { data: { mcp_server_id: USER_ID }, error: /mcp_server_id/ },
        { data: { created_at: new Date().toISOString() }, error: /created_at/ },
        { data: { config_version: Number.MAX_SAFE_INTEGER }, error: /config_version/ },
        { data: { mcp_runtime: {} }, error: /mcp_runtime/ },
        { data: { runtime_generation: 9 }, error: /runtime_generation/ },
        {
          data: { headers: { 'X-Secret': 'sentinel}}' } },
          error: /unbalanced template delimiter/,
        },
        {
          data: { auth: { type: 'oauth', oauth_client_secret: 'sentinel{{' } },
          error: /unbalanced template delimiter/,
        },
        { data: { expected_config_version: Number.MAX_SAFE_INTEGER + 1 }, error: /safe integer/ },
        { data: { tool_permissions: { search: 'sometimes' } }, error: /tool_permissions/ },
        { data: { replace_auth: true }, error: /replace_auth requires auth/ },
        {
          data: { auth: { token: 'wrong-mode' } },
          error: /does not apply|auth\.type is required/,
        },
      ];
      for (const entry of invalidMutations) {
        for (const method of ['PATCH', 'PUT'] as const) {
          if (transport === 'REST') {
            const response = await restWrite(harness, method, entry.data, created.mcp_server_id);
            expect(
              response.status,
              `${method} ${JSON.stringify(entry.data)}: ${JSON.stringify(response.body)}`
            ).toBe(400);
            expect(String(response.body.message)).toMatch(entry.error);
          } else {
            const service = harness.client.service('mcp-servers');
            const request =
              method === 'PATCH'
                ? service.patch(created.mcp_server_id, entry.data)
                : service.update(created.mcp_server_id, entry.data);
            await expect(request).rejects.toThrow(entry.error);
          }
        }
      }
    }
  );

  it.each(['REST', 'Socket.IO'] as const)(
    'persists CREATE auth:null as no auth over real %s transport',
    async (transport) => {
      const harness = await createHarness();
      harnesses.push(harness);
      const payload = { ...createInput(), auth: null };
      const created =
        transport === 'REST'
          ? (await restWrite(harness, 'POST', payload)).body
          : ((await harness.client.service('mcp-servers').create(payload)) as MCPServer);
      expect(created.auth).toBeUndefined();
      expect(
        (await harness.repository.findById(String(created.mcp_server_id)))?.auth
      ).toBeUndefined();
    }
  );

  it.each(['REST', 'Socket.IO'] as const)(
    'validates the effective row and cleans HTTP↔stdio transitions over real %s transport',
    async (transport) => {
      const harness = await createHarness();
      harnesses.push(harness);
      const remote = await harness.repository.create({
        ...createInput({ type: 'bearer', token: 'remote-secret' }),
        headers: { 'X-Remote': 'configured' },
      });
      const service = harness.client.service('mcp-servers');

      const toStdio =
        transport === 'REST'
          ? await restWrite(
              harness,
              'PATCH',
              { transport: 'stdio', command: 'node', args: ['server.js'] },
              remote.mcp_server_id
            )
          : {
              status: 200,
              body: (await service.patch(remote.mcp_server_id, {
                transport: 'stdio',
                command: 'node',
                args: ['server.js'],
              })) as unknown as Record<string, unknown>,
            };
      expect(toStdio.status).toBe(200);
      expect(await harness.repository.findById(remote.mcp_server_id)).toMatchObject({
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
      });
      const storedStdio = await harness.repository.findById(remote.mcp_server_id);
      expect(storedStdio?.url).toBeUndefined();
      expect(storedStdio?.headers).toBeUndefined();
      expect(storedStdio?.auth).toBeUndefined();

      const toHttp =
        transport === 'REST'
          ? await restWrite(
              harness,
              'PATCH',
              { transport: 'http', url: 'https://next.example.test/mcp' },
              remote.mcp_server_id
            )
          : {
              status: 200,
              body: (await service.patch(remote.mcp_server_id, {
                transport: 'http',
                url: 'https://next.example.test/mcp',
              })) as unknown as Record<string, unknown>,
            };
      expect(toHttp.status).toBe(200);
      const storedHttp = await harness.repository.findById(remote.mcp_server_id);
      expect(storedHttp).toMatchObject({
        transport: 'http',
        url: 'https://next.example.test/mcp',
      });
      expect(storedHttp?.command).toBeUndefined();
      expect(storedHttp?.args).toBeUndefined();

      const invalidRequests = [
        { data: { command: 'must-not-append' }, error: /only apply to stdio/ },
        { data: { transport: 'stdio' }, error: /command is required/ },
      ];
      for (const invalid of invalidRequests) {
        if (transport === 'REST') {
          const response = await restWrite(harness, 'PATCH', invalid.data, remote.mcp_server_id);
          expect(response.status).toBe(400);
          expect(String(response.body.message)).toMatch(invalid.error);
        } else {
          await expect(service.patch(remote.mcp_server_id, invalid.data)).rejects.toThrow(
            invalid.error
          );
        }
      }
    }
  );

  it.each(['REST', 'Socket.IO'] as const)(
    'applies PUT replacement to omitted non-secret configuration over real %s transport',
    async (transport) => {
      const harness = await createHarness();
      harnesses.push(harness);
      const created = await harness.repository.create({
        ...createInput({ type: 'bearer', token: 'old-token' }),
        description: 'remove me',
        headers: { 'X-Old': 'header' },
        env: { OLD_SECRET: 'value' },
        tool_permissions: { search: 'allow' },
      });
      const replacement = {
        display_name: 'PUT replacement',
        transport: 'http',
        url: 'https://replacement.example.test/mcp',
        scope: 'global',
        enabled: true,
      };
      const incomplete = { ...replacement, url: undefined };
      if (transport === 'REST') {
        const rejected = await restWrite(harness, 'PUT', incomplete, created.mcp_server_id);
        expect(rejected.status).toBe(400);
        expect(String(rejected.body.message)).toMatch(/url is required/);
      } else {
        await expect(
          harness.client.service('mcp-servers').update(created.mcp_server_id, incomplete)
        ).rejects.toThrow(/url is required/);
      }
      if (transport === 'REST') {
        expect((await restWrite(harness, 'PUT', replacement, created.mcp_server_id)).status).toBe(
          200
        );
      } else {
        await harness.client.service('mcp-servers').update(created.mcp_server_id, replacement);
      }
      const stored = await harness.repository.findById(created.mcp_server_id);
      expect(stored).toMatchObject({
        display_name: 'PUT replacement',
        transport: 'http',
        url: 'https://replacement.example.test/mcp',
      });
      expect(stored?.description).toBeUndefined();
      expect(stored?.headers).toBeUndefined();
      expect(stored?.env).toBeUndefined();
      expect(stored?.auth).toBeUndefined();
      expect(stored?.tool_permissions).toBeUndefined();
    }
  );

  it.each([
    {
      label: 'bearer',
      auth: { type: 'bearer', token: 'bearer-secret' } as MCPAuth,
      putAuth: { type: 'bearer', token: MCP_HEADER_REDACTED_SENTINEL },
      secretField: 'token',
      secret: 'bearer-secret',
    },
    {
      label: 'JWT',
      auth: {
        type: 'jwt',
        api_url: 'https://auth.example.test/token',
        api_token: 'jwt-token',
        api_secret: 'jwt-secret',
      } as MCPAuth,
      putAuth: {
        type: 'jwt',
        api_url: 'https://auth.example.test/token',
        api_token: MCP_HEADER_REDACTED_SENTINEL,
        api_secret: MCP_HEADER_REDACTED_SENTINEL,
      },
      secretField: 'api_secret',
      secret: 'jwt-secret',
    },
    {
      label: 'OAuth',
      auth: {
        type: 'oauth',
        oauth_client_secret: 'oauth-secret',
        oauth_access_token: 'oauth-access',
        oauth_refresh_token: 'oauth-refresh',
      } as MCPAuth,
      putAuth: {
        type: 'oauth',
        oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
        oauth_access_token: MCP_HEADER_REDACTED_SENTINEL,
        oauth_refresh_token: MCP_HEADER_REDACTED_SENTINEL,
      },
      secretField: 'oauth_client_secret',
      secret: 'oauth-secret',
    },
  ])(
    'redacts real responses/events and preserves $label plus header/env sentinels on PUT',
    async (entry) => {
      const harness = await createHarness();
      harnesses.push(harness);
      const createdEvent = new Promise<MCPServer>((resolve) => {
        harness.client.service('mcp-servers').once('created', resolve);
      });
      const created = await restWrite(harness, 'POST', {
        ...createInput(entry.auth),
        headers: { 'X-Secret': 'header-secret' },
        env: { MCP_SECRET: 'env-secret' },
      });
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain(entry.secret);
      expect(JSON.stringify(created.body)).not.toContain('header-secret');
      expect(JSON.stringify(created.body)).not.toContain('env-secret');
      const createdEventJson = JSON.stringify(await createdEvent);
      expect(createdEventJson).not.toContain(entry.secret);
      expect(createdEventJson).not.toContain('header-secret');
      expect(createdEventJson).not.toContain('env-secret');

      const id = String(created.body.mcp_server_id);
      const updatedEvent = new Promise<MCPServer>((resolve) => {
        harness.client.service('mcp-servers').once('updated', resolve);
      });
      const put = (await harness.client.service('mcp-servers').update(id, {
        display_name: 'Replacement label',
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        scope: 'global',
        enabled: true,
        auth: entry.putAuth,
        headers: { 'X-Secret': MCP_HEADER_REDACTED_SENTINEL },
        env: { MCP_SECRET: MCP_HEADER_REDACTED_SENTINEL },
      })) as MCPServer;
      expect(JSON.stringify(put)).not.toContain(entry.secret);
      const updatedEventJson = JSON.stringify(await updatedEvent);
      expect(updatedEventJson).not.toContain(entry.secret);
      expect(updatedEventJson).not.toContain('header-secret');
      expect(updatedEventJson).not.toContain('env-secret');
      const stored = await harness.repository.findById(id);
      expect(stored?.auth?.[entry.secretField as keyof MCPAuth]).toBe(entry.secret);
      expect(stored).toMatchObject({
        display_name: 'Replacement label',
        headers: { 'X-Secret': 'header-secret' },
        env: { MCP_SECRET: 'env-secret' },
      });

      const cleared = await restWrite(harness, 'PATCH', { auth: null }, id);
      expect(cleared.status).toBe(200);
      expect((await harness.repository.findById(id))?.auth).toBeUndefined();
    }
  );

  it.each(['REST', 'Socket.IO'] as const)(
    'allows explicit bearer/JWT/OAuth secret clears and keeps the row editable over real %s',
    async (transport) => {
      const harness = await createHarness();
      harnesses.push(harness);
      const service = harness.client.service('mcp-servers');
      const cases: Array<{ auth: MCPAuth; clear: Record<string, unknown>; expected: MCPAuth }> = [
        {
          auth: { type: 'bearer', token: 'saved-token' },
          clear: { type: 'bearer', token: null },
          expected: { type: 'bearer' },
        },
        {
          auth: {
            type: 'jwt',
            api_url: 'https://auth.example.test/token',
            api_token: 'saved-token',
            api_secret: 'saved-secret',
          },
          clear: { type: 'jwt', api_token: null, api_secret: null },
          expected: { type: 'jwt', api_url: 'https://auth.example.test/token' },
        },
        {
          auth: {
            type: 'oauth',
            oauth_client_id: 'client',
            oauth_client_secret: 'saved-secret',
          },
          clear: { type: 'oauth', oauth_client_secret: null },
          expected: { type: 'oauth', oauth_client_id: 'client' },
        },
      ];

      for (const [index, entry] of cases.entries()) {
        const created = await harness.repository.create({
          ...createInput(entry.auth),
          name: `clear-${index}`,
        });
        if (transport === 'REST') {
          const response = await restWrite(
            harness,
            'PATCH',
            { auth: entry.clear },
            created.mcp_server_id
          );
          expect(response.status).toBe(200);
        } else {
          await service.patch(created.mcp_server_id, { auth: entry.clear } as never);
        }
        expect((await harness.repository.findById(created.mcp_server_id))?.auth).toEqual(
          entry.expected
        );

        const label = `still-editable-${index}`;
        await service.patch(created.mcp_server_id, { display_name: label });
        expect(await harness.repository.findById(created.mcp_server_id)).toMatchObject({
          display_name: label,
          auth: entry.expected,
        });
      }
    }
  );

  it.each(['REST', 'Socket.IO'] as const)(
    'honors PUT replace_auth:false merge compatibility over real %s',
    async (transport) => {
      const harness = await createHarness();
      harnesses.push(harness);
      const created = await harness.repository.create(
        createInput({
          type: 'oauth',
          oauth_client_id: 'saved-client',
          oauth_client_secret: 'saved-secret',
          oauth_scope: 'before',
        })
      );
      const put = {
        display_name: 'Merged PUT',
        transport: 'http' as const,
        url: 'https://mcp.example.test/mcp',
        scope: 'global' as const,
        enabled: true,
        replace_auth: false,
        auth: { oauth_scope: 'after' },
      };
      if (transport === 'REST') {
        expect((await restWrite(harness, 'PUT', put, created.mcp_server_id)).status).toBe(200);
      } else {
        await harness.client.service('mcp-servers').update(created.mcp_server_id, put as never);
      }
      expect((await harness.repository.findById(created.mcp_server_id))?.auth).toEqual({
        type: 'oauth',
        oauth_client_id: 'saved-client',
        oauth_client_secret: 'saved-secret',
        oauth_scope: 'after',
      });
    }
  );

  it('keeps trusted catalog provenance on the in-process contract only', async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const external = await restWrite(harness, 'POST', {
      ...createInput({ type: 'oauth' }),
      source: 'catalog',
      catalog_entry_name: 'io.example.mcp',
    });
    expect(external.status).toBe(400);

    // Repository/catalog/import callers are explicit trusted in-process paths;
    // they still pass the final effective-row contract before persistence.
    await expect(
      harness.repository.create({
        ...createInput({ type: 'oauth' }),
        source: 'catalog',
      })
    ).rejects.toThrow(/catalog_entry_name is required/);
    const trusted = await harness.repository.create({
      ...createInput({ type: 'oauth' }),
      source: 'catalog',
      catalog_entry_name: 'io.example.mcp',
    });
    expect(trusted).toMatchObject({ source: 'catalog', catalog_entry_name: 'io.example.mcp' });
  });

  it('deletes the caller-scoped OAuth grant when an enabled server is disabled', async () => {
    const probe: CoordinatorProbe = {
      pendingServerIds: new Set(),
      invalidatedServerIds: [],
      lockServerIds: [],
    };
    const harness = await createHarness(AUTH_TOKEN, probe);
    harnesses.push(harness);
    const created = await harness.repository.create({
      ...createInput({ type: 'oauth', oauth_mode: 'per_user' }),
      name: 'disable-removes-oauth',
    });
    await harness.grants.saveToken(null, created.mcp_server_id, {
      accessToken: 'saved-access-token',
      refreshToken: 'saved-refresh-token',
    });
    probe.pendingServerIds.add(created.mcp_server_id);

    const patched = (await harness.client
      .service('mcp-servers')
      .patch(created.mcp_server_id, { enabled: false })) as MCPServer;

    expect(patched.enabled).toBe(false);
    await expect(harness.grants.getToken(null, created.mcp_server_id)).resolves.toBeNull();
    expect(probe.invalidatedServerIds).toEqual([created.mcp_server_id]);
    expect(probe.lockServerIds).toEqual([created.mcp_server_id]);
  });

  it.each(['rest-patch', 'socket-put'] as const)(
    'canonicalizes a short ID for configuration, grant, pending-flow, and lock work over %s',
    async (transportCase) => {
      const probe: CoordinatorProbe = {
        pendingServerIds: new Set(),
        invalidatedServerIds: [],
        lockServerIds: [],
      };
      const harness = await createHarness(AUTH_TOKEN, probe);
      harnesses.push(harness);
      const created = await harness.repository.create({
        ...createInput({
          type: 'oauth',
          oauth_mode: 'per_user',
          oauth_client_id: 'client-id',
          oauth_client_secret: 'client-secret',
          oauth_scope: 'before',
        }),
        name: `short-${transportCase}`,
      });
      const fullId = created.mcp_server_id;
      const abbreviatedId = shortId(fullId);
      await harness.grants.saveToken(null, fullId, {
        accessToken: 'historical-access-token',
      });
      probe.pendingServerIds.add(fullId);

      if (transportCase === 'rest-patch') {
        const response = await restWrite(
          harness,
          'PATCH',
          { auth: { oauth_scope: 'after-rest' } },
          abbreviatedId
        );
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ mcp_server_id: fullId });
      } else {
        const response = (await harness.client.service('mcp-servers').update(abbreviatedId, {
          display_name: 'Short PUT',
          transport: 'http',
          url: 'https://mcp.example.test/mcp',
          scope: 'global',
          enabled: true,
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_client_id: 'client-id',
            oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
            oauth_scope: 'after-socket',
          },
        })) as MCPServer;
        expect(response).toMatchObject({ mcp_server_id: fullId, display_name: 'Short PUT' });
        expect(response.auth?.oauth_client_secret).toBe(MCP_HEADER_REDACTED_SENTINEL);
      }

      const stored = await harness.repository.findById(fullId);
      expect(stored?.auth?.oauth_scope).toBe(
        transportCase === 'rest-patch' ? 'after-rest' : 'after-socket'
      );
      expect(stored?.auth?.oauth_client_secret).toBe('client-secret');
      await expect(harness.grants.getToken(null, fullId)).resolves.toBeNull();
      expect(probe.pendingServerIds.has(fullId)).toBe(false);
      expect(probe.invalidatedServerIds).toEqual([fullId]);
      expect(probe.lockServerIds).toEqual([fullId]);
    }
  );
});
