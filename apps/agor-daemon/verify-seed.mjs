/**
 * Seed one Slack-bound gateway session in an isolated daemon home, so the real
 * daemon has something to project. Everything the stage-3 code actually does
 * — binding, minting, posting, redemption — happens in the daemon, not here.
 */

import { writeFileSync } from 'node:fs';
import {
  BranchRepository,
  createDatabase,
  GatewayChannelRepository,
  initializeDatabase,
  MCPServerRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  ThreadSessionMapRepository,
  UserApiKeysRepository,
  UsersRepository,
} from '@agor/core/db';

const DB = process.env.SEED_DB_URL;
const THREAD_ROOT = '1700000000.000001';
const SLACK_CHANNEL = 'C_STUB';
const THREAD_ID = `${SLACK_CHANNEL}-${THREAD_ROOT}`;

const db = createDatabase({ url: DB, dialect: 'sqlite' });
await initializeDatabase(db);

const out = await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
  const users = new UsersRepository(scoped);
  const actor = await users.create({
    email: `slack-actor-${Date.now()}@example.invalid`,
    name: 'Slack Actor',
    role: 'admin',
  });
  const stranger = await users.create({
    email: `slack-stranger-${Date.now()}@example.invalid`,
    name: 'Someone Else',
    role: 'admin',
  });
  const repo = await new RepoRepository(scoped).create({
    slug: `verify-${Date.now()}`,
    name: 'verify',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/verify.git',
    local_path: '/tmp/agor-verify/repo',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(scoped).create({
    repo_id: repo.repo_id,
    name: 'verify',
    path: '/tmp/agor-verify/repo',
    ref: 'main',
    branch_unique_id: 4242,
    created_by: actor.user_id,
  });
  const session = await new SessionRepository(scoped).create({
    branch_id: branch.branch_id,
    title: 'Slack thread',
    created_by: actor.user_id,
  });
  const channel = await new GatewayChannelRepository(scoped).create({
    name: 'verify-slack',
    channel_type: 'slack',
    target_branch_id: branch.branch_id,
    agor_user_id: actor.user_id,
    enabled: true,
    created_by: actor.user_id,
    config: {
      bot_token: 'xoxb-stub-token',
      app_token: 'xapp-stub-token',
      align_slack_users: true,
      allowed_channel_ids: [SLACK_CHANNEL],
    },
  });
  await new ThreadSessionMapRepository(scoped).create({
    channel_id: channel.id,
    thread_id: THREAD_ID,
    session_id: session.session_id,
    branch_id: branch.branch_id,
    status: 'active',
  });
  const server = await new MCPServerRepository(scoped).create({
    name: 'Notion',
    display_name: 'Notion',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    enabled: true,
    scope: 'session',
    created_by: actor.user_id,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  });
  const task = await new TaskRepository(scoped).create({
    session_id: session.session_id,
    full_prompt: 'connect me to notion',
    created_by: actor.user_id,
    status: 'completed',
    metadata: {
      gateway_task_source: {
        gateway_channel_id: channel.id,
        channel_type: 'slack',
        thread_id: THREAD_ID,
        provider_user_id: 'U_HUMAN',
        slack_team_id: 'T_STUB',
        slack_channel_id: SLACK_CHANNEL,
        slack_conversation_type: 'channel',
      },
    },
  });
  const apiKey = await new UserApiKeysRepository(scoped).create(actor.user_id, 'verify');
  const strangerKey = await new UserApiKeysRepository(scoped).create(stranger.user_id, 'verify');
  return {
    actorId: actor.user_id,
    strangerId: stranger.user_id,
    branchId: branch.branch_id,
    sessionId: session.session_id,
    channelId: channel.id,
    serverId: server.mcp_server_id,
    taskId: task.task_id,
    threadId: THREAD_ID,
    apiKey: apiKey.rawKey,
    strangerApiKey: strangerKey.rawKey,
  };
});

writeFileSync('/tmp/agor-verify/seed.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
