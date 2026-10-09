import {
  BoardRepository,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  GatewayChannelRepository,
  initializeDatabase,
  isPostgresDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TeamsConversationAddressRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import { getConnector } from '@agor/core/gateway';
import { SessionStatus, type TenantID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateId } from '../../../../../packages/core/src/lib/ids';
import type { McpContext } from '../server';
import { tenantScopedToolProxy } from '../tenant-scope';
import { registerGatewayChannelTools } from './gateway-channels';

vi.mock('@agor/core/gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/gateway')>()),
  getConnector: vi.fn(),
}));

process.env.AGOR_MASTER_SECRET ||= 'teams-channel-history-tenant-scope-test-secret';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

const TEAMS_CHANNEL = '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2';
const ROOT = '1616989510408';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Teams channel history MCP tools (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL required');
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    async function seedTenant(tenantId: TenantID, db: Database, seenChannel: boolean) {
      return runWithTenantDatabaseScope(db, tenantId, async () => {
        const user = await new UsersRepository(db).create({
          email: `${generateId()}@example.invalid`,
          role: 'admin',
        });
        const repo = await new RepoRepository(db).create({
          slug: `teams-history-${generateId()}`,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/test.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const board = await new BoardRepository(db).create({
          name: 'Teams history tenant scope',
          created_by: user.user_id,
          access_mode: 'private',
        });
        const branch = await new BranchRepository(db).create({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          permission_binding: 'inherit',
          created_by: user.user_id,
          name: 'teams-history',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${generateId()}`,
        });
        const appId = `teams-app-${tenantId}`;
        const channel = await new GatewayChannelRepository(db).create({
          name: `Teams ${tenantId}`,
          channel_type: 'teams',
          target_branch_id: branch.branch_id,
          agor_user_id: user.user_id,
          created_by: user.user_id,
          enabled: true,
          provider_installation_id: appId,
          config: {
            app_id: appId,
            app_password: `teams-secret-${tenantId}`,
            microsoft_tenant_id: 'ms-tenant',
            align_teams_users: false,
            outbound_enabled: true,
            agent_tools: { channel_history: true },
          } as never,
        });
        if (seenChannel) {
          await new TeamsConversationAddressRepository(db).refresh({
            gatewayChannelId: channel.id,
            threadId: `${TEAMS_CHANNEL}|${ROOT}`,
            conversationId: TEAMS_CHANNEL,
            rootMessageId: ROOT,
            teamId: '19:team@thread.tacv2',
            address: { serviceUrl: 'https://smba.trafficmanager.net/amer/' },
            verifiedAppId: appId,
            verifiedTenantId: 'ms-tenant',
            providerConfigGeneration: channel.provider_config_generation,
          });
        }
        const session = await new SessionRepository(db).create({
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
          model_config: { mode: 'alias', model: 'sonnet', updated_at: new Date().toISOString() },
          tasks: [],
          genealogy: { children: [] },
        });
        return { user, channel, session };
      });
    }

    function toolFor(
      db: Database,
      tenantId: TenantID,
      user: { user_id: string },
      sessionId?: string,
      toolName = 'agor_gateway_teams_channel_posts_list'
    ): Handler {
      const app = feathers();
      app.set('config', {});
      const ctx = {
        app,
        db,
        ...(sessionId ? { sessionId } : {}),
        userId: user.user_id,
        authenticatedUser: user,
        baseServiceParams: {
          user,
          provider: 'mcp',
          authenticated: true,
          tenant: { tenant_id: tenantId, source: 'explicit' },
        },
      } as unknown as McpContext;
      const handlers: Record<string, Handler> = {};
      const server = {
        registerTool: (name: string, _config: unknown, handler: Handler) => {
          handlers[name] = handler;
        },
      } as unknown as McpServer;
      registerGatewayChannelTools(tenantScopedToolProxy(server, ctx), ctx);
      return handlers[toolName]!;
    }

    it("reads through the caller's own tenant address and never another tenant's", async () => {
      const db = createTenantScopedDatabaseProxy(rawDb, { label: 'daemon database' });
      const tenantA = `teams-a-${generateId()}` as TenantID;
      const tenantB = `teams-b-${generateId()}` as TenantID;
      const a = await seedTenant(tenantA, db, true);
      const b = await seedTenant(tenantB, db, false);
      const listChannelPosts = vi.fn(async () => ({
        channelId: TEAMS_CHANNEL,
        posts: [],
        has_more: false,
        next_cursor: null,
      }));
      vi.mocked(getConnector).mockReturnValue({ listChannelPosts } as never);

      const own = toolFor(db, tenantA, a.user, a.session.session_id);
      await own({ gatewayChannelId: a.channel.id, teamsChannelId: TEAMS_CHANNEL });
      expect(vi.mocked(getConnector).mock.calls[0]![1]).toMatchObject({
        app_password: `teams-secret-${tenantA}`,
      });
      expect(listChannelPosts).toHaveBeenCalledWith(
        expect.objectContaining({
          team: expect.objectContaining({ teamId: '19:team@thread.tacv2' }),
          cacheScope: expect.objectContaining({ agorTenantId: tenantA }),
        })
      );

      vi.mocked(getConnector).mockClear();
      // Tenant B's own channel cannot borrow tenant A's proof of having seen the Teams channel.
      const ownB = toolFor(db, tenantB, b.user, b.session.session_id);
      await expect(
        ownB({ gatewayChannelId: b.channel.id, teamsChannelId: TEAMS_CHANNEL })
      ).rejects.toThrow(/has not received an activity/);
      // Tenant A's gateway channel is indistinguishable from a missing one.
      const foreign = toolFor(db, tenantB, b.user);
      await expect(
        foreign({ gatewayChannelId: a.channel.id, teamsChannelId: TEAMS_CHANNEL })
      ).rejects.toThrow(/Gateway channel not found/);
      const replay = toolFor(db, tenantB, b.user, a.session.session_id);
      await expect(
        replay({ gatewayChannelId: a.channel.id, teamsChannelId: TEAMS_CHANNEL })
      ).rejects.toThrow(/calling session not found/);
      expect(getConnector).not.toHaveBeenCalled();
    });

    it("lists only the caller tenant's Teams targets and anchors", async () => {
      const db = createTenantScopedDatabaseProxy(rawDb, { label: 'daemon database' });
      const tenantA = `teams-targets-a-${generateId()}` as TenantID;
      const tenantB = `teams-targets-b-${generateId()}` as TenantID;
      const a = await seedTenant(tenantA, db, true);
      const b = await seedTenant(tenantB, db, false);
      const listTeamChannels = vi.fn(async () => [{ id: TEAMS_CHANNEL, name: 'General' }]);
      vi.mocked(getConnector).mockReset();
      vi.mocked(getConnector).mockReturnValue({ listTeamChannels } as never);
      const targets = 'agor_gateway_outbound_targets_list';

      const own = toolFor(db, tenantA, a.user, undefined, targets);
      const ownPayload = JSON.parse((await own({ channelType: 'teams' })).content[0]!.text);
      expect(ownPayload.channels).toEqual([
        expect.objectContaining({
          gateway_channel_id: a.channel.id,
          known_channels: [{ teams_channel_id: TEAMS_CHANNEL, name: 'General' }],
        }),
      ]);

      listTeamChannels.mockClear();
      // Tenant B sees only its own channel, and its channel has no anchor from tenant A's address.
      const foreign = toolFor(db, tenantB, b.user, undefined, targets);
      const foreignPayload = JSON.parse((await foreign({ channelType: 'teams' })).content[0]!.text);
      expect(foreignPayload.channels).toEqual([
        expect.objectContaining({ gateway_channel_id: b.channel.id, known_channels: [] }),
      ]);
      expect(JSON.stringify(foreignPayload)).not.toContain(a.channel.id);
      expect(listTeamChannels).not.toHaveBeenCalled();
    });
  }
);
