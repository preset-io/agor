/** Scratch fixture builder for the stage-2 real-lane HTTP drive. Not shipped. */
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  GatewayChannelRepository,
  generateId,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '@agor/core/db';

const raw = createDatabase({ dialect: 'sqlite', url: `file:${process.env.HOME}/.agor/agor.db` });
const db = createTenantScopedDatabaseProxy(raw, { requireScope: true, label: 'stage2 fixture' });

const out = await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
  const users = new UsersRepository(scoped);
  const admin = (await users.findByEmail('admin@agor.live'))!;

  const repo = await new RepoRepository(scoped).create({
    name: `stage2-${crypto.randomUUID().slice(0, 8)}`,
    slug: `stage2-${crypto.randomUUID().slice(0, 8)}`,
    path: '/tmp/stage2-repo',
    repo_type: 'local',
    local_path: '/tmp/stage2-repo',
    default_branch: 'main',
    created_by: admin.user_id,
  });
  const branch = await new BranchRepository(scoped).create({
    repo_id: repo.repo_id,
    name: `stage2-${crypto.randomUUID().slice(0, 8)}`,
    branch_name: 'stage2',
    ref: 'refs/heads/stage2',
    branch_unique_id: Math.floor(Math.random() * 9000) + 1000,
    path: '/tmp/stage2-branch',
    created_by: admin.user_id,
  });
  const channel = await new GatewayChannelRepository(scoped).create({
    name: 'stage2-slack',
    channel_type: 'slack',
    enabled: true,
    agor_user_id: admin.user_id,
    config: { align_slack_users: true, bot_token: 'xoxb-stage2', app_token: 'xapp-stage2' },
    created_by: admin.user_id,
    target_branch_id: branch.branch_id,
  });
  const session = await new SessionRepository(scoped).create({
    branch_id: branch.branch_id,
    name: 'stage2 gateway session',
    agentic_tool: 'claude-code',
    created_by: admin.user_id,
    custom_context: {
      gateway: { channel_id: channel.id, channel_type: 'slack', channel_name: 'stage2-slack' },
    },
  });
  const threadId = 'C0STAGE2-1789560000.000100';
  await new ThreadSessionMapRepository(scoped).create({
    channel_id: channel.id,
    thread_id: threadId,
    session_id: session.session_id,
    branch_id: branch.branch_id,
  });
  const server = await new MCPServerRepository(scoped).create({
    name: `stage2-notion-${crypto.randomUUID().slice(0, 6)}`,
    display_name: 'Notion',
    transport: 'http',
    url: process.env.STAGE2_MCP_URL ?? 'http://127.0.0.1:9320/mcp',
    scope: 'global',
    enabled: true,
    source: 'user',
    owner_user_id: admin.user_id,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  });
  const task = await new TaskRepository(scoped).create({
    session_id: session.session_id,
    prompt: 'connect me to Notion',
    created_by: admin.user_id,
    metadata: {
      gateway_task_source: {
        gateway_channel_id: channel.id,
        channel_type: 'slack',
        thread_id: threadId,
        provider_user_id: 'U0STAGE2',
        slack_team_id: 'T0STAGE2',
        slack_channel_id: 'C0STAGE2',
      },
    },
  });
  const widgetId = generateId();
  await new MessagesRepository(scoped).create({
    message_id: widgetId,
    session_id: session.session_id,
    task_id: task.task_id,
    type: 'widget_request',
    role: 'system',
    index: 0,
    timestamp: new Date().toISOString(),
    content: 'Connect "Notion"',
    content_preview: 'Widget: oauth (Notion)',
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
          serverName: 'Notion',
          oauthMode: 'per_user',
          reason: 'Read the roadmap page.',
          catalogEntryName: 'com.notion/mcp',
          permissionDisclosure: 'Agor will read and write pages you share with it.',
        },
      },
    },
  });
  return {
    adminUserId: admin.user_id,
    channelId: channel.id,
    sessionId: session.session_id,
    branchId: branch.branch_id,
    taskId: task.task_id,
    widgetId,
    serverId: server.mcp_server_id,
    threadId,
  };
});
console.log(JSON.stringify(out, null, 2));
