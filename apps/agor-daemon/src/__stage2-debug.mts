import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  GatewayChannelRepository,
  MCPServerRepository,
  MessagesRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '@agor/core/db';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import {
  gatewaySourceMatchesConnectClaims,
  readPendingOAuthConnectWidget,
} from './services/mcp-oauth-connect-delivery.js';
import { readSlackMCPOAuthAuthority } from './services/mcp-slack-oauth-authority.js';
import {
  mcpOAuthConnectClaimsMatchDelivery,
  verifyMCPOAuthConnectToken,
} from './utils/mcp-oauth-connect-token.js';

const token = process.env.STAGE2_TOKEN!;
const claims = verifyMCPOAuthConnectToken(token, process.env.AGOR_MASTER_SECRET!);
console.log('claims ok', { widget: claims.widget_id, sub: claims.sub, tid: claims.tid });
const raw = createDatabase({ dialect: 'sqlite', url: `file:${process.env.HOME}/.agor/agor.db` });
const db = createTenantScopedDatabaseProxy(raw, { requireScope: true, label: 'stage2 debug' });
await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
  const message = await new MessagesRepository(scoped).findById(claims.widget_id);
  const pending = readPendingOAuthConnectWidget(message);
  console.log(
    'message?',
    !!message,
    'pending?',
    !!pending,
    'task_id',
    message?.task_id,
    'session',
    message?.session_id
  );
  console.log(
    'deliveryMatch',
    mcpOAuthConnectClaimsMatchDelivery(claims, pending?.widget.slack_connect, 'default')
  );
  const task = await new TaskRepository(scoped).findById(claims.task_id);
  console.log(
    'gatewaySourceMatch',
    gatewaySourceMatchesConnectClaims(task, claims),
    task?.metadata?.gateway_task_source
  );
  const authority = await readSlackMCPOAuthAuthority(
    {
      sessions: new SessionRepository(scoped),
      users: new UsersRepository(scoped),
      channels: new GatewayChannelRepository(scoped),
      servers: new MCPServerRepository(scoped),
      threadMap: new ThreadSessionMapRepository(scoped),
    },
    {
      principalUserId: claims.sub,
      credentialUserId: claims.credential_user_id,
      sessionId: claims.session_id,
      gatewayChannelId: claims.gateway_channel_id,
      gatewayConfigGeneration: claims.gateway_config_generation,
      slackChannelId: claims.slack_channel_id,
      slackThreadId: claims.slack_thread_id,
      mcpServerId: claims.mcp_server_id,
      mcpServerConfigVersion: claims.mcp_server_config_version,
    }
  );
  console.log('authority?', !!authority);
  if (authority) {
    console.log('ownerMatch', authority.session.created_by === claims.session_owner_user_id);
    console.log(
      'modeMatch',
      (authority.server.auth?.oauth_mode ?? 'per_user') === claims.oauth_mode
    );
    console.log('usable', isMCPServerUsableBy(authority.server, claims.credential_user_id));
  } else {
    const ch = await new GatewayChannelRepository(scoped).findById(claims.gateway_channel_id);
    const sv = await new MCPServerRepository(scoped).findById(claims.mcp_server_id);
    const map = await new ThreadSessionMapRepository(scoped).findBySession(claims.session_id);
    const pr = await new UsersRepository(scoped).findById(claims.sub);
    console.log({
      channel: ch && {
        enabled: ch.enabled,
        type: ch.channel_type,
        gen: ch.provider_config_generation,
        config: ch.config,
      },
      server: sv && { enabled: sv.enabled, auth: sv.auth?.type, cv: sv.config_version },
      map,
      principalRole: pr?.role,
      claimsGen: claims.gateway_config_generation,
      claimsCv: claims.mcp_server_config_version,
    });
  }
});
