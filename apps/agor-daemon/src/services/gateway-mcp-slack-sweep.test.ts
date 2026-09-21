/**
 * The bounded repair sweep, against real rows.
 *
 * `gateway-mcp-slack-connect.test.ts` stubs every repository, which is the
 * right shape for pinning what one delivery decides and the wrong shape for
 * two questions this lane has now been bitten by twice:
 *
 *   1. What does the sweep actually SEE? Its page is an indexed range scan
 *      over real rows, so a card that never reaches the page is invisible to
 *      any test that hands the delivery a widget id directly.
 *   2. What runs outside a tenant database scope? A suite that stubs the
 *      repositories has no guard to trip (§7.1.3), and the two missing scopes
 *      before it were found by driving a real daemon rather than by a test.
 *
 * So this file wires a real migrated database, real repositories, and the
 * daemon's own scope guard into `GatewayService`, and replaces Slack's
 * connector and nothing else. See
 * `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.1.5.
 */

import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  GatewayChannelRepository,
  generateId,
  MCPServerRepository,
  MessagesRepository,
  MissingTenantDatabaseScopeError,
  RepoRepository,
  runMigrations,
  runWithTenantContext,
  SessionRepository,
  TaskRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '@agor/core/db';
import type { MessageID, TenantScopeAwareDatabase, UserID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

interface SentSlackMessage {
  threadId: string;
  text: string;
  blocks?: { type: string }[];
  metadata?: Record<string, unknown>;
}

const sent = vi.hoisted(() => ({ messages: [] as SentSlackMessage[] }));
vi.mock('@agor/core/gateway', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/gateway');
  return {
    ...actual,
    getConnector: () => ({
      channelType: 'slack',
      getAppInfo: async () => ({ teamId: 'T500' }),
      sendMessage: async (request: SentSlackMessage) => {
        sent.messages.push(request);
        return `1700000500.${String(sent.messages.length).padStart(6, '0')}`;
      },
    }),
  };
});

import { GatewayService } from './gateway.js';

const TENANT = 'default';
const SECRET = 'connect-sweep-test-master-secret';

/**
 * Set for the whole file rather than around each drive: gateway channel
 * credentials are encrypted with it at create time, so a harness that seeds a
 * channel outside the secret cannot read its own config back.
 */
let previousSecret: string | undefined;
let previousBaseUrl: string | undefined;
beforeAll(() => {
  previousSecret = process.env.AGOR_MASTER_SECRET;
  process.env.AGOR_MASTER_SECRET = SECRET;
  // A public URL is the other ingredient of a link. Without one `getBaseUrl`
  // answers `http://localhost:{port}` and the lane refuses the binding as
  // `no_public_url` — correct behaviour, pinned in
  // `gateway-mcp-slack-connect.test.ts`, and not what this file is about.
  previousBaseUrl = process.env.AGOR_BASE_URL;
  process.env.AGOR_BASE_URL = 'https://agor.example.test';
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
  else process.env.AGOR_MASTER_SECRET = previousSecret;
  if (previousBaseUrl === undefined) delete process.env.AGOR_BASE_URL;
  else process.env.AGOR_BASE_URL = previousBaseUrl;
});

const services: GatewayService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopListeners();
  sent.messages.length = 0;
});

/**
 * One tenant, real rows, one Slack workspace.
 *
 * `aligned` and `unaligned` are two real gateway channels, because the
 * refusal this lane keeps a marker for (`unaligned`) is a property of the
 * channel a widget's Task came from — so starving one set of cards with
 * another needs two of them.
 */
async function createSweepHarness() {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  // The production guard, not an opt-in: every repository read the sweep
  // performs outside a tenant database scope throws here, which is the only
  // thing that could have caught the four scope defects before a daemon did.
  const db = createTenantScopedDatabaseProxy(rawDb, {
    requireScope: true,
    label: 'connect sweep harness',
  }) as unknown as TenantScopeAwareDatabase;

  const user = await new UsersRepository(rawDb).create({
    email: `sweep-${generateId()}@example.com`,
    role: 'admin',
  });
  const server = await new MCPServerRepository(rawDb).create({
    name: 'sweep-oauth-server',
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    scope: 'global',
    owner_user_id: user.user_id as UserID,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  });
  const repo = await new RepoRepository(rawDb).create({
    slug: `sweep-${generateId()}`,
    name: 'Sweep repo',
    repo_type: 'local',
    local_path: `/tmp/sweep-${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(rawDb).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: `sweep-${generateId()}`,
    ref: 'main',
    branch_unique_id: 100_000 + Math.floor(Math.random() * 1_000_000_000),
    path: `/tmp/sweep-${generateId()}/branch`,
    created_by: user.user_id,
  });
  const sessions = new SessionRepository(rawDb);
  const threadMap = new ThreadSessionMapRepository(rawDb);

  const channels = new GatewayChannelRepository(rawDb);
  const makeChannel = async (name: string, aligned: boolean) =>
    channels.create({
      name,
      channel_type: 'slack',
      enabled: true,
      created_by: user.user_id,
      agor_user_id: user.user_id,
      target_branch_id: branch.branch_id,
      config: {
        align_slack_users: aligned,
        bot_token: 'xoxb-test-only',
        app_token: 'xapp-test-only',
      },
    });
  const aligned = await makeChannel('Sweep aligned', true);
  const unaligned = await makeChannel('Sweep unaligned', false);

  const tasks = new TaskRepository(rawDb);
  const messages = new MessagesRepository(rawDb);
  let index = 0;

  /** A Slack-sourced `oauth` widget carrying nothing but its mint marker. */
  async function seedWidget(options: {
    channelId: string;
    slackChannelId: string;
    requestedAt: string;
  }): Promise<MessageID> {
    const threadId = `${options.slackChannelId}-1756200000.${String(index).padStart(6, '0')}`;
    // One session per widget, with its own thread map row: the authority read
    // proves the card's thread against `findBySession`, so a thread and a
    // session are one-to-one for this lane.
    const session = await sessions.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: user.user_id,
    });
    await threadMap.create({
      channel_id: options.channelId,
      thread_id: threadId,
      session_id: session.session_id,
      branch_id: branch.branch_id,
    });
    const taskId = generateId();
    await tasks.create({
      task_id: taskId,
      session_id: session.session_id,
      created_by: user.user_id,
      full_prompt: 'connect me',
      status: TaskStatus.COMPLETED,
      message_range: { start_index: 0, end_index: 0, start_timestamp: options.requestedAt },
      git_state: { ref_at_start: 'main', sha_at_start: 'sweep' },
      tool_use_count: 0,
      metadata: {
        gateway_task_source: {
          gateway_channel_id: options.channelId,
          channel_type: 'slack',
          thread_id: threadId,
          provider_user_id: 'U500',
          slack_team_id: 'T500',
          slack_channel_id: options.slackChannelId,
          // A DM, so a delivered card is exactly one send.
          slack_conversation_type: 'im',
        },
      },
    });
    const widgetId = generateId();
    await messages.create({
      message_id: widgetId,
      session_id: session.session_id,
      task_id: taskId,
      type: 'widget_request',
      role: 'system',
      index: index++,
      timestamp: options.requestedAt,
      content: 'Connect this server',
      content_preview: 'Widget: oauth',
      metadata: {
        widget: {
          widget_type: 'oauth',
          widget_id: widgetId,
          schema_version: 1,
          status: 'pending',
          requested_at: options.requestedAt,
          // The lane's only durable trigger before a link exists.
          slack_connect_due_at: options.requestedAt,
          params: {
            mcpServerId: server.mcp_server_id,
            serverName: 'Sweep server',
            oauthMode: 'per_user',
            reason: 'Read the roadmap page.',
          },
        },
      },
    });
    return widgetId as MessageID;
  }

  const service = new GatewayService(db, {
    get: () => undefined,
  } as never);
  services.push(service);

  return {
    rawDb,
    service,
    user,
    aligned,
    unaligned,
    seedWidget,
    widget: async (widgetId: MessageID) =>
      (await messages.findById(widgetId))?.metadata?.widget ?? undefined,
    /** Run one bounded repair pass for this tenant and wait for it to finish. */
    sweep: async () => {
      const internals = service as unknown as {
        scheduleMcpSlackRecoveryRepair(tenantId: string): void;
        mcpSlackRepairTenants: Set<string>;
      };
      runWithTenantContext(TENANT, () => internals.scheduleMcpSlackRecoveryRepair(TENANT));
      const deadline = Date.now() + 20_000;
      while (internals.mcpSlackRepairTenants.has(TENANT)) {
        if (Date.now() > deadline) throw new Error('Bounded repair sweep did not finish');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

describe('Slack MCP connect bounded repair sweep', () => {
  /**
   * A full page of first-card markers the lane refuses for a reason an
   * administrator can undo, ahead of one healthy card.
   *
   * Preserving those markers is right — `unaligned` is reversible and the
   * marker is the card's only durable trigger. Preserving their overdue queue
   * position is not: the page is the oldest fifty rows, so before the fix the
   * healthy card behind them never got a first delivery or a repair until the
   * blockers changed or aged out of the sweep's 24-hour horizon.
   */
  it('delivers a healthy card sitting behind a full page of refused markers', async () => {
    const harness = await createSweepHarness();
    const blockedAt = new Date(Date.now() - 60 * 60_000);
    for (let i = 0; i < 50; i += 1) {
      await harness.seedWidget({
        channelId: harness.unaligned.id,
        slackChannelId: 'C501',
        // Strictly older than the healthy card, so they own the whole page.
        requestedAt: new Date(blockedAt.getTime() + i).toISOString(),
      });
    }
    const healthy = await harness.seedWidget({
      channelId: harness.aligned.id,
      slackChannelId: 'C500',
      requestedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    await harness.sweep();
    // A second pass, because the fix that matters is that the blockers stop
    // owning the front of the queue — not that one tick reaches past them.
    await harness.sweep();

    const widget = await harness.widget(healthy);
    expect(widget?.slack_connect?.slack_message_ts).toEqual(expect.any(String));
    expect(widget?.slack_connect?.rendered_state).toBe('connect_required');
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0]?.blocks?.some((block) => block.type === 'actions')).toBe(true);
  }, 30_000);

  /**
   * The restart case, automated: §7.1.2 drove it by hand against a real
   * daemon after the first-card trigger shipped, and it is the shape that
   * found the fourth missing tenant scope.
   *
   * Nothing in process knows this widget exists — no deferred projection, no
   * timer, no realtime event. All that survives a restart is the mint marker,
   * and the entry point is the one a daemon start actually calls.
   */
  it('posts a first card from nothing but the durable mint marker', async () => {
    const harness = await createSweepHarness();
    const widgetId = await harness.seedWidget({
      channelId: harness.aligned.id,
      slackChannelId: 'C500',
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // `refreshChannelState` is what a daemon start runs: it discovers the
    // tenant's Slack channels and arms the bounded repair sweep.
    await runWithTenantContext(TENANT, () => harness.service.refreshChannelState());
    const internals = harness.service as unknown as { mcpSlackRepairTenants: Set<string> };
    const deadline = Date.now() + 20_000;
    while (internals.mcpSlackRepairTenants.has(TENANT)) {
      if (Date.now() > deadline) throw new Error('Bounded repair sweep did not finish');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(sent.messages).toHaveLength(1);
    const posted = sent.messages[0]!;
    const action = posted.blocks?.find((block) => block.type === 'actions') as
      | { elements?: { url?: string }[] }
      | undefined;
    // A real sealed token, minted through the real authority reads.
    expect(action?.elements?.[0]?.url).toMatch(/#token=/);
    expect(posted.metadata).toHaveProperty('slack_message_metadata');

    const widget = await harness.widget(widgetId);
    expect(widget?.slack_connect).toMatchObject({
      slack_message_ts: expect.any(String),
      rendered_state: 'connect_required',
      delivery_generation: 1,
    });
  }, 30_000);

  /**
   * The silence the architecture pass asked about.
   *
   * Both lanes' per-item repair used to be `.catch(() => undefined)`, which is
   * how four missing tenant scopes reached a running daemon: the failure
   * happens BEFORE any delivery is attempted, so the `stranded=true` delivery
   * accounting never sees it either. One bounded line per (lane, category) per
   * pass — never the exception, never anything the provider said.
   */
  it('reports the per-item repair failures it used to swallow', async () => {
    const harness = await createSweepHarness();
    for (let i = 0; i < 2; i += 1) {
      await harness.seedWidget({
        channelId: harness.aligned.id,
        slackChannelId: 'C500',
        requestedAt: new Date(Date.now() - 60_000 - i).toISOString(),
      });
    }
    (harness.service as unknown as Record<string, unknown>).deliverMcpSlackConnectCard =
      async () => {
        throw new MissingTenantDatabaseScopeError('messages');
      };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await harness.sweep();
      const line = warn.mock.calls
        .map((call) => call[0])
        .find(
          (value): value is string =>
            typeof value === 'string' && value.includes('event=mcp_slack_repair_failed')
        );
      expect(line).toBeDefined();
      expect(line).toContain('tenant_id=default');
      expect(line).toContain('lane=connect');
      expect(line).toContain('reason=missing_tenant_scope');
      // Tallied, not one line per row: a systemic failure fails for the whole
      // page, and the count is the story.
      expect(line).toContain('count=2');
      expect(line).toContain('first_entity_id=');
      expect(line).not.toMatch(/Missing tenant database scope|Error|C500/);
      expect(sent.messages).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it('does not post a second card on the next sweep', async () => {
    const harness = await createSweepHarness();
    await harness.seedWidget({
      channelId: harness.aligned.id,
      slackChannelId: 'C500',
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await harness.sweep();
    await harness.sweep();

    expect(sent.messages).toHaveLength(1);
  }, 30_000);
});
