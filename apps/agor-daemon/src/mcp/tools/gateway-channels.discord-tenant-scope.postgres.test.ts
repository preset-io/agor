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

process.env.AGOR_MASTER_SECRET ||= 'discord-channel-history-tenant-scope-test-secret';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

const snowflake = () => `1${String(Math.floor(Math.random() * 1e17)).padStart(17, '0')}`;

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Discord channel history MCP tool (PostgreSQL/RLS)',
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

    async function seedTenant(tenantId: TenantID, db: Database) {
      return runWithTenantDatabaseScope(db, tenantId, async () => {
        const user = await new UsersRepository(db).create({
          email: `${generateId()}@example.invalid`,
          role: 'admin',
        });
        const repo = await new RepoRepository(db).create({
          slug: `discord-history-${generateId()}`,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/test.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const board = await new BoardRepository(db).create({
          name: 'Discord history tenant scope',
          created_by: user.user_id,
          access_mode: 'private',
        });
        const branch = await new BranchRepository(db).create({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          permission_binding: 'inherit',
          created_by: user.user_id,
          name: 'discord-history',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${generateId()}`,
        });
        const applicationId = snowflake();
        const parentChannelId = snowflake();
        const channel = await new GatewayChannelRepository(db).create({
          name: `Discord ${tenantId}`,
          channel_type: 'discord',
          target_branch_id: branch.branch_id,
          agor_user_id: user.user_id,
          created_by: user.user_id,
          enabled: true,
          provider_installation_id: applicationId,
          config: {
            bot_token: `bot-token-${tenantId}`,
            application_id: applicationId,
            guild_id: snowflake(),
            allowed_channel_ids: [parentChannelId],
            allowed_user_ids: [snowflake()],
            message_content_enabled: true,
            thread_mode: 'public_thread_per_summon',
            align_discord_users: false,
            agent_tools: { channel_history: true },
          } as never,
        });
        const session = await new SessionRepository(db).create({
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
          model_config: { mode: 'alias', model: 'sonnet', updated_at: new Date().toISOString() },
          tasks: [],
          genealogy: { children: [] },
        });
        return { user, channel, session, parentChannelId };
      });
    }

    function toolFor(
      db: Database,
      tenantId: TenantID,
      user: { user_id: string },
      sessionId?: string
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
      return handlers.agor_gateway_discord_channel_history_get!;
    }

    it("reads through the caller's own tenant and cannot reach another tenant's channel", async () => {
      const db = createTenantScopedDatabaseProxy(rawDb, { label: 'daemon database' });
      const tenantA = `discord-a-${generateId()}` as TenantID;
      const tenantB = `discord-b-${generateId()}` as TenantID;
      const a = await seedTenant(tenantA, db);
      const b = await seedTenant(tenantB, db);
      const fetchChannelHistory = vi.fn(async (req: { channelId?: string }) => ({
        channelId: req.channelId,
        messages: [],
        has_more: false,
        next_cursor: null,
      }));
      vi.mocked(getConnector).mockReturnValue({ fetchChannelHistory } as never);

      const own = toolFor(db, tenantA, a.user, a.session.session_id);
      const result = await own({
        gatewayChannelId: a.channel.id,
        discordChannelId: a.parentChannelId,
      });
      expect(JSON.parse(result.content[0]!.text).channel).toEqual({
        discord_channel_id: a.parentChannelId,
      });
      expect(vi.mocked(getConnector).mock.calls[0]![1]).toMatchObject({
        bot_token: `bot-token-${tenantA}`,
      });

      vi.mocked(getConnector).mockClear();
      // Tenant B admin without session context: tenant A's channel ID is
      // indistinguishable from a missing one.
      const foreign = toolFor(db, tenantB, b.user);
      await expect(
        foreign({ gatewayChannelId: a.channel.id, discordChannelId: a.parentChannelId })
      ).rejects.toThrow(/Gateway channel not found/);
      // Replaying tenant A's session ID from tenant B fails closed.
      const replay = toolFor(db, tenantB, b.user, a.session.session_id);
      await expect(
        replay({ gatewayChannelId: a.channel.id, discordChannelId: a.parentChannelId })
      ).rejects.toThrow(/calling session not found/);
      expect(getConnector).not.toHaveBeenCalled();
    });
  }
);
