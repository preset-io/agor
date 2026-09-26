/** Native PostgreSQL short suspension/release proof for the real connect preflight and start services. */
import { randomUUID } from 'node:crypto';
import {
  applyTenantRestrictionIntent,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  executeRaw,
  GatewayChannelRepository,
  generateId,
  lockTenantExecutionFence,
  MCPServerRepository,
  MessagesRepository,
  type RawDatabase,
  RepoRepository,
  readTenantExecutionBoundary,
  readTenantRestrictionGeneration,
  runMigrations,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  SessionRepository,
  sql,
  TaskRepository,
  type TenantScopeAwareDatabase,
  ThreadSessionMapRepository,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import type { AuthenticatedParams, MessageID, UserID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isCurrentTenantEventAdmitted } from './auth/tenant-access.js';
import { type RegisterServicesContext, registerMCPServices } from './register-services.js';
import { issueMCPOAuthConnectLink } from './services/mcp-oauth-connect-delivery.js';

const providerMock = vi.hoisted(() => ({
  realStart: false,
  onMetadata: undefined as (() => Promise<void>) | undefined,
  dcrPosts: 0,
  onExchange: undefined as (() => Promise<void>) | undefined,
  onStart: undefined as (() => Promise<void>) | undefined,
  exchanges: 0,
  startedFlows: 0,
}));
vi.mock('@agor/core/utils/safe-outbound-fetch', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agor/core/utils/safe-outbound-fetch')>();
  return {
    ...original,
    safeOutboundFetch: async (
      url: string | URL,
      options: Parameters<typeof original.safeOutboundFetch>[1]
    ) => {
      if (!providerMock.realStart) return original.safeOutboundFetch(url, options);
      try {
        await options?.assertCurrent?.();
      } catch (error) {
        throw new original.OutboundPreDispatchAuthorityError(error);
      }
      const target = String(url);
      if (options?.method === 'POST') {
        providerMock.dcrPosts += 1;
        const request = JSON.parse(String(options.body)) as { redirect_uris: string[] };
        return new Response(
          JSON.stringify({ client_id: 'r10-dcr-client', redirect_uris: request.redirect_uris }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      if (target.includes('oauth-protected-resource')) {
        return new Response(
          JSON.stringify({
            resource: 'https://oauth.example.test/saved/mcp',
            authorization_servers: ['https://oauth.example.test'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (target.includes('oauth-authorization-server')) {
        await providerMock.onMetadata?.();
        return new Response(
          JSON.stringify({
            issuer: 'https://oauth.example.test',
            authorization_endpoint: 'https://oauth.example.test/authorize',
            token_endpoint: 'https://oauth.example.test/token',
            registration_endpoint: 'https://oauth.example.test/register',
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected mocked provider URL: ${target}`);
    },
  };
});
vi.mock('@agor/core/tools/mcp/oauth-mcp-transport', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@agor/core/tools/mcp/oauth-mcp-transport')>();
  return {
    ...original,
    resolveMCPOAuthDiscovery: async () => ({
      kind: 'resource-metadata' as const,
      metadataUrl: 'https://oauth.example.test/.well-known/oauth-protected-resource',
      source: 'header' as const,
    }),
    startMCPOAuthFlow: async (
      _challenge: string,
      clientId: string,
      redirectUri: string,
      options: { resourceUri: string; compatibilityMode: 'strict' }
    ) => {
      providerMock.startedFlows += 1;
      if (providerMock.realStart) {
        return original.startMCPOAuthFlow(_challenge, clientId, redirectUri, options);
      }
      await providerMock.onStart?.();
      const state = randomUUID();
      return {
        metadataUrl: 'https://oauth.example.test/.well-known/oauth-protected-resource',
        resourceUri: options.resourceUri,
        issuer: 'https://oauth.example.test',
        authorizationEndpoint: 'https://oauth.example.test/authorize',
        tokenEndpoint: 'https://oauth.example.test/token',
        redirectUri,
        pkceVerifier: 'r9-pkce-verifier',
        clientId,
        state,
        authorizationUrl: `https://oauth.example.test/authorize?state=${state}`,
        compatibilityMode: options.compatibilityMode,
        authorizationResponseIssuerParameterSupported: true,
        allowLocalhostHttp: false,
      };
    },
    completeMCPOAuthFlow: async () => {
      providerMock.exchanges += 1;
      await providerMock.onExchange?.();
      return { access_token: 'r9-test-access', refresh_token: 'r9-test-refresh', expires_in: 3600 };
    },
  };
});

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'Slack MCP connect durable resume cutoff (PostgreSQL)',
  () => {
    let raw: RawDatabase;
    let db: TenantScopeAwareDatabase;
    let app: Application;
    let priorSecret: string | undefined;
    const providerUrl = 'https://oauth.example.test';
    let oauthCallbackHandler: Awaited<
      ReturnType<typeof registerMCPServices>
    >['oauthCallbackHandler'];
    let tokenRequested: (() => void) | undefined;
    let releaseToken: (() => void) | undefined;
    let probeHold: (() => Promise<void>) | undefined;
    const providerRequests: string[] = [];

    beforeAll(async () => {
      priorSecret = process.env.AGOR_MASTER_SECRET;
      process.env.AGOR_MASTER_SECRET = 'r9-connect-pg-test-secret'.padEnd(64, 'x');
      raw = createDatabase({ dialect: 'postgresql', url: url! });
      await runMigrations(raw);
      db = createTenantScopedDatabaseProxy(raw, { requireScope: true, label: 'r9-connect-pg' });
      app = feathers() as Application;
      app.use(
        '/gateway',
        {
          async syncMcpSlackRecoveryNoticeAfterCommit() {},
          async syncMcpSlackConnectCard() {},
          async markMcpSlackOAuthResult() {},
        },
        {
          methods: [
            'syncMcpSlackRecoveryNoticeAfterCommit',
            'syncMcpSlackConnectCard',
            'markMcpSlackOAuthResult',
          ],
        }
      );
      ({ oauthCallbackHandler } = await registerMCPServices({
        db,
        app,
        config: {} as RegisterServicesContext['config'],
        jwtSecret: 'r9-test-jwt',
        daemonUrl: 'http://127.0.0.1:3030',
        bundledUiAvailable: false,
        DAEMON_PORT: 3030,
        UI_PORT: 5173,
        allowSuperadmin: false,
        requireAuth: async (context) => context,
        deployment: {} as RegisterServicesContext['deployment'],
        mcpOAuthCallbackUrl: 'https://agor.example.test/oauth/callback',
        mcpOAuthFetch: async () => {
          providerRequests.push('/saved/mcp');
          await probeHold?.();
          return new Response(null, {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${providerUrl}/.well-known/oauth-protected-resource"`,
            },
          });
        },
      }));
    });

    afterAll(async () => {
      if (raw) await (raw as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
      if (priorSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = priorSecret;
    });

    async function seed(tenantId: string, dcr = false) {
      return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${randomUUID()}@example.test`,
          role: 'admin',
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `r9-${randomUUID()}`,
          name: 'R9 connect repo',
          repo_type: 'local',
          local_path: `/tmp/r9-${randomUUID()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'r9',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
          path: `/tmp/r9-${randomUUID()}/branch`,
          created_by: user.user_id,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'claude-code',
          created_by: user.user_id,
        });
        const channel = await new GatewayChannelRepository(scoped).create({
          name: 'R9 Slack connect',
          channel_type: 'slack',
          enabled: true,
          created_by: user.user_id,
          agor_user_id: user.user_id,
          target_branch_id: branch.branch_id,
          config: {
            align_slack_users: true,
            bot_token: 'xoxb-test-only',
            app_token: 'xapp-test-only',
          },
        });
        const threadId = 'C2515-1756200000.000002';
        await new ThreadSessionMapRepository(scoped).create({
          channel_id: channel.id,
          thread_id: threadId,
          session_id: session.session_id,
          branch_id: branch.branch_id,
        });
        const server = await new MCPServerRepository(scoped).create({
          name: 'R9 OAuth server',
          transport: 'http',
          url: `${providerUrl}/saved/mcp`,
          headers: { 'X-Test': 'true' },
          scope: 'global',
          owner_user_id: user.user_id as UserID,
          auth: dcr ? { type: 'oauth' } : { type: 'oauth', oauth_client_id: 'r9-client' },
        });
        const taskId = generateId();
        await new TaskRepository(scoped).create({
          task_id: taskId,
          session_id: session.session_id,
          created_by: user.user_id,
          full_prompt: 'connect me',
          status: TaskStatus.COMPLETED,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'r9' },
          tool_use_count: 0,
          metadata: {
            gateway_task_source: {
              gateway_channel_id: channel.id,
              channel_type: 'slack',
              thread_id: threadId,
              provider_user_id: 'U2515',
              slack_team_id: 'T2515',
              slack_channel_id: 'C2515',
            },
          },
        });
        const widgetId = generateId() as MessageID;
        const messages = new MessagesRepository(scoped);
        await messages.create({
          message_id: widgetId,
          session_id: session.session_id,
          task_id: taskId,
          type: 'widget_request',
          role: 'system',
          index: 0,
          timestamp: new Date().toISOString(),
          content: 'Connect this server',
          content_preview: 'Widget: oauth',
          metadata: {
            widget: {
              widget_type: 'oauth',
              widget_id: widgetId,
              schema_version: 1,
              status: 'pending',
              requested_at: new Date().toISOString(),
              tenant_restriction_generation: await readTenantRestrictionGeneration(
                scoped,
                tenantId
              ),
              auto_resume: true,
              params: {
                mcpServerId: server.mcp_server_id,
                serverName: 'R9 OAuth server',
                oauthMode: 'per_user',
                reason: 'Read a page',
              },
            },
          },
        });
        const issued = await issueMCPOAuthConnectLink(
          {
            repositories: {
              sessions: new SessionRepository(scoped),
              users: new UsersRepository(scoped),
              channels: new GatewayChannelRepository(scoped),
              servers: new MCPServerRepository(scoped),
              threadMap: new ThreadSessionMapRepository(scoped),
            },
            messages,
            tasks: new TaskRepository(scoped),
            masterSecret: process.env.AGOR_MASTER_SECRET!,
            baseUrl: 'https://agor.example.test',
          },
          { tenantId, widgetId }
        );
        if (!issued) throw new Error('Expected connect link');
        return {
          widgetId,
          serverId: server.mcp_server_id,
          userId: user.user_id,
          token: decodeURIComponent(issued.url.split('#token=')[1]),
          params: {
            user,
            tenant: { tenant_id: tenantId, source: 'explicit' },
          } as AuthenticatedParams,
        };
      });
    }

    async function suspendAndReactivate(tenantId: string) {
      const base = {
        version: 1 as const,
        controllerId: 'r9-controller',
        placementId: 'r9-placement',
        operationId: 'suspend',
        revision: 1,
      };
      await applyTenantRestrictionIntent(raw, tenantId, { ...base, action: 'restrict' });
      await applyTenantRestrictionIntent(raw, tenantId, {
        ...base,
        operationId: 'reactivate',
        revision: 2,
        action: 'prepare_release',
      });
      await applyTenantRestrictionIntent(raw, tenantId, {
        ...base,
        operationId: 'reactivate',
        revision: 2,
        action: 'activate',
      });
      return runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        readTenantExecutionBoundary(scoped, tenantId)
      );
    }

    it('rejects unvisited and retired old links after a short cycle; admits fresh A and neighbor B', async () => {
      const a = `r9-a-${randomUUID()}`;
      const b = `r9-b-${randomUUID()}`;
      const unvisited = await seed(a);
      const retired = await seed(a);
      const neighbor = await seed(b);
      await suspendAndReactivate(a);
      // Pin a same-second cutoff in the owned test DB. The old widget is then
      // deliberately given a fast daemon clock; its DB epoch must still lose.
      const boundary = await runWithTenantDatabaseScope(db, a, async (scoped) => {
        await executeRaw(
          scoped,
          sql`UPDATE public.tenant_restrictions
              SET updated_at = date_trunc('second', updated_at) + interval '500 milliseconds'
              WHERE tenant_id = ${a} AND controller_id = 'r9-controller'`
        );
        return readTenantExecutionBoundary(scoped, a);
      });
      expect(boundary.allowed).toBe(true);
      expect(boundary.resumeAfter).toBeDefined();
      await runWithTenantDatabaseScope(db, a, async (scoped) => {
        const cutoff = boundary.resumeAfter!;
        expect(await isCurrentTenantEventAdmitted(scoped, cutoff)).toBe(false);
        expect(await isCurrentTenantEventAdmitted(scoped, cutoff + 1)).toBe(true);
        // A five-second-ahead daemon makes this old widget appear newer than
        // the DB cutoff. Generation, not requested_at, remains authoritative.
        await new MessagesRepository(scoped).mutateMetadataLocked(
          unvisited.widgetId,
          (metadata) => ({
            ...metadata,
            widget: { ...metadata!.widget!, requested_at: new Date(cutoff + 5_000).toISOString() },
          })
        );
      });
      await runWithTenantDatabaseScope(db, a, async (scoped) => {
        await new MessagesRepository(scoped).mutateMetadataLocked(retired.widgetId, (metadata) => ({
          ...metadata,
          widget: {
            ...metadata!.widget!,
            slack_connect: {
              ...metadata!.widget!.slack_connect!,
              binding_invalidated_at: new Date().toISOString(),
            },
          },
        }));
      });
      const beforeOldRedemption = providerRequests.length;
      for (const old of [unvisited, retired]) {
        await expect(
          app.service('mcp-oauth-connect').create({ token: old.token }, old.params)
        ).rejects.toMatchObject({ code: 403 });
        const start = (await app
          .service('mcp-servers/oauth-start')
          .create({ connect_token: old.token }, old.params)) as { success: boolean };
        expect(start.success).toBe(false);
        await runWithTenantDatabaseScope(db, a, async (scoped) => {
          expect(
            (await new MessagesRepository(scoped).findById(old.widgetId))?.metadata?.widget
              ?.slack_connect?.token_consumed_at
          ).toBeUndefined();
        });
      }
      expect(providerRequests).toHaveLength(beforeOldRedemption);
      const fresh = await seed(a);
      // Slow daemon clocks are harmless too: a fresh widget minted under the
      // new DB epoch wins even with a timestamp before the release cutoff.
      await runWithTenantDatabaseScope(db, a, async (scoped) => {
        await new MessagesRepository(scoped).mutateMetadataLocked(fresh.widgetId, (metadata) => ({
          ...metadata,
          widget: {
            ...metadata!.widget!,
            requested_at: new Date(boundary.resumeAfter! - 5_000).toISOString(),
          },
        }));
      });
      await expect(
        app.service('mcp-oauth-connect').create({ token: fresh.token }, fresh.params)
      ).resolves.toMatchObject({ state: 'connect_required' });
      await expect(
        app.service('mcp-oauth-connect').create({ token: neighbor.token }, neighbor.params)
      ).resolves.toMatchObject({ state: 'connect_required' });
      for (const allowed of [fresh, neighbor]) {
        const start = (await app
          .service('mcp-servers/oauth-start')
          .create({ connect_token: allowed.token }, allowed.params)) as { success: boolean };
        expect(start.success).toBe(true);
      }
    });

    it('serializes a consumed link behind a concurrent restriction fence', async () => {
      const tenantId = `r9-consume-${randomUUID()}`;
      const seeded = await seed(tenantId);
      await app.service('mcp-oauth-connect').create({ token: seeded.token }, seeded.params);
      let releaseFence!: () => void;
      let fenceHeld!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseFence = resolve;
      });
      const held = new Promise<void>((resolve) => {
        fenceHeld = resolve;
      });
      const base = {
        version: 1 as const,
        controllerId: 'r9-race-controller',
        placementId: 'r9-race-placement',
        operationId: 'suspend',
        revision: 1,
      };
      const restriction = runWithTenantDatabaseTransaction(db, tenantId, async (scoped) => {
        await lockTenantExecutionFence(scoped, tenantId);
        fenceHeld();
        await release;
        await applyTenantRestrictionIntent(raw, tenantId, { ...base, action: 'restrict' });
      });
      await held;
      const start = app
        .service('mcp-servers/oauth-start')
        .create({ connect_token: seeded.token }, seeded.params) as Promise<{ success: boolean }>;
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseFence();
      await restriction;
      expect((await start).success).toBe(false);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        expect(
          (await new MessagesRepository(scoped).findById(seeded.widgetId))?.metadata?.widget
            ?.slack_connect?.token_consumed_at
        ).toBeUndefined();
      });
      await applyTenantRestrictionIntent(raw, tenantId, {
        ...base,
        operationId: 'reactivate',
        revision: 2,
        action: 'prepare_release',
      });
      await applyTenantRestrictionIntent(raw, tenantId, {
        ...base,
        operationId: 'reactivate',
        revision: 2,
        action: 'activate',
      });
      await expect(
        app.service('mcp-oauth-connect').create({ token: seeded.token }, seeded.params)
      ).rejects.toMatchObject({ code: 403 });
    });

    it('does not invent freshness for legacy unstamped widgets after restriction history', async () => {
      const tenantId = `r10-legacy-${randomUUID()}`;
      const old = await seed(tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await new MessagesRepository(scoped).mutateMetadataLocked(old.widgetId, (metadata) => {
          const { tenant_restriction_generation: _generation, ...widget } = metadata!.widget!;
          return { ...metadata, widget };
        });
      });
      await expect(
        app.service('mcp-oauth-connect').create({ token: old.token }, old.params)
      ).resolves.toMatchObject({ state: 'connect_required' });
      await suspendAndReactivate(tenantId);
      await expect(
        app.service('mcp-oauth-connect').create({ token: old.token }, old.params)
      ).rejects.toMatchObject({ code: 403 });
    });

    it('fences the real inner metadata GET to DCR POST boundary across a short cycle', async () => {
      const tenantId = `r10-dcr-${randomUUID()}`;
      const old = await seed(tenantId, true);
      let metadataEntered!: () => void;
      let releaseMetadata!: () => void;
      const entered = new Promise<void>((resolve) => {
        metadataEntered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseMetadata = resolve;
      });
      providerMock.realStart = true;
      providerMock.dcrPosts = 0;
      providerMock.onMetadata = () => {
        metadataEntered();
        return held;
      };
      try {
        const start = app
          .service('mcp-servers/oauth-start')
          .create({ connect_token: old.token }, old.params) as Promise<{ success: boolean }>;
        await entered;
        await suspendAndReactivate(tenantId);
        releaseMetadata();
        expect((await start).success).toBe(false);
        expect(providerMock.dcrPosts).toBe(0);
        await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          expect(
            (await new MessagesRepository(scoped).findById(old.widgetId))?.metadata?.widget
              ?.slack_connect?.oauth_failed_at
          ).toBeDefined();
        });
        const fresh = await seed(tenantId, true);
        providerMock.onMetadata = undefined;
        const result = (await app
          .service('mcp-servers/oauth-start')
          .create({ connect_token: fresh.token }, fresh.params)) as { success: boolean };
        expect(result).toMatchObject({ success: true });
        expect(providerMock.dcrPosts).toBe(1);
        const neighbor = await seed(`r10-neighbor-${randomUUID()}`);
        const configured = (await app
          .service('mcp-servers/oauth-start')
          .create({ connect_token: neighbor.token }, neighbor.params)) as { success: boolean };
        expect(configured.success).toBe(true);
        expect(providerMock.dcrPosts).toBe(1);
      } finally {
        releaseMetadata();
        providerMock.realStart = false;
        providerMock.onMetadata = undefined;
      }
    });

    it('does not advance from an in-flight provider probe after a short suspend/release', async () => {
      const tenantId = `r9-probe-${randomUUID()}`;
      const seeded = await seed(tenantId);
      let requested!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      probeHold = () => {
        requested();
        return gate;
      };
      const priorFlows = providerMock.startedFlows;
      const start = app
        .service('mcp-servers/oauth-start')
        .create({ connect_token: seeded.token }, seeded.params) as Promise<{ success: boolean }>;
      await entered;
      await suspendAndReactivate(tenantId);
      release();
      expect((await start).success).toBe(false);
      expect(providerMock.startedFlows).toBe(priorFlows);
      probeHold = undefined;
    });

    it('refuses an authorization URL constructed before a short suspend/release', async () => {
      const tenantId = `r9-open-${randomUUID()}`;
      const seeded = await seed(tenantId);
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      providerMock.onStart = () => {
        entered();
        return gate;
      };
      const start = app
        .service('mcp-servers/oauth-start')
        .create({ connect_token: seeded.token }, seeded.params) as Promise<{ success: boolean }>;
      await reached;
      await suspendAndReactivate(tenantId);
      release();
      expect((await start).success).toBe(false);
      providerMock.onStart = undefined;
    });

    it('rejects an in-flight callback after short suspension even when the provider later answers', async () => {
      const tenantId = `r9-flight-${randomUUID()}`;
      const seeded = await seed(tenantId);
      const started = (await app
        .service('mcp-servers/oauth-start')
        .create({ connect_token: seeded.token }, seeded.params)) as {
        success: boolean;
        authorizationUrl: string;
      };
      expect(started.success).toBe(true);
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      expect(state).toBeTruthy();

      const requested = new Promise<void>((resolve) => {
        tokenRequested = resolve;
      });
      providerMock.onExchange = () =>
        new Promise<void>((resolve) => {
          tokenRequested?.();
          releaseToken = resolve;
        });
      let status = 200;
      const response = {
        setHeader() {},
        status(code: number) {
          status = code;
          return this;
        },
        send() {
          return this;
        },
      };
      const callback = (
        oauthCallbackHandler as unknown as (req: unknown, res: unknown) => Promise<void>
      )({ query: { code: 'authorization-code', state, iss: providerUrl } }, response);
      await requested;
      await suspendAndReactivate(tenantId);
      releaseToken?.();
      await callback;
      expect(status).not.toBe(200);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        expect(
          await new UserMCPOAuthTokenRepository(scoped).getToken(
            seeded.userId as UserID,
            seeded.serverId
          )
        ).toBeNull();
      });
      expect(providerMock.exchanges).toBeGreaterThan(0);
      tokenRequested = undefined;
      releaseToken = undefined;
      providerMock.onExchange = undefined;
    });
  }
);
