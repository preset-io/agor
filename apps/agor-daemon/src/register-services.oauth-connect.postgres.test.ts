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
  onExchange: undefined as (() => Promise<void>) | undefined,
  onStart: undefined as (() => Promise<void>) | undefined,
  exchanges: 0,
  startedFlows: 0,
}));
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
        mcpOAuthCallbackUrl: 'http://127.0.0.1:3030/oauth/callback',
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

    async function seed(tenantId: string) {
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
          auth: { type: 'oauth', oauth_client_id: 'r9-client' },
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
      // Pin a same-second millisecond boundary in the owned test database.
      // Production writes the timestamp; controlling only this fixture's
      // clock makes both sides of the strict comparison deterministic.
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
        // Equality is stale even when the link's iat is rounded to the same
        // whole second. This is an old record with no repair-sweep visit.
        await new MessagesRepository(scoped).mutateMetadataLocked(
          unvisited.widgetId,
          (metadata) => ({
            ...metadata,
            widget: { ...metadata!.widget!, requested_at: new Date(cutoff).toISOString() },
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
      while (Date.now() <= boundary.resumeAfter!)
        await new Promise((resolve) => setTimeout(resolve, 1));
      const fresh = await seed(a);
      // Unlike token iat, the widget timestamp retains milliseconds; a
      // fresh event one millisecond after release in that SAME second wins.
      await runWithTenantDatabaseScope(db, a, async (scoped) => {
        await new MessagesRepository(scoped).mutateMetadataLocked(fresh.widgetId, (metadata) => ({
          ...metadata,
          widget: {
            ...metadata!.widget!,
            requested_at: new Date(boundary.resumeAfter! + 1).toISOString(),
          },
        }));
      });
      expect(Math.floor((boundary.resumeAfter! + 1) / 1_000)).toBe(
        Math.floor(boundary.resumeAfter! / 1_000)
      );
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
