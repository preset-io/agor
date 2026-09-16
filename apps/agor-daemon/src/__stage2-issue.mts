/** Issue a real connect link against the scratch daemon's database. Not shipped. */
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
import { issueMCPOAuthConnectLink } from './services/mcp-oauth-connect-delivery.js';

const fixture = JSON.parse(process.env.STAGE2_FIXTURE!);
const raw = createDatabase({ dialect: 'sqlite', url: `file:${process.env.HOME}/.agor/agor.db` });
const db = createTenantScopedDatabaseProxy(raw, { requireScope: true, label: 'stage2 issue' });

const result = await runWithTenantDatabaseScope(db, 'default', (scoped) =>
  issueMCPOAuthConnectLink(
    {
      repositories: {
        sessions: new SessionRepository(scoped),
        users: new UsersRepository(scoped),
        channels: new GatewayChannelRepository(scoped),
        servers: new MCPServerRepository(scoped),
        threadMap: new ThreadSessionMapRepository(scoped),
      },
      messages: new MessagesRepository(scoped),
      tasks: new TaskRepository(scoped),
      masterSecret: process.env.AGOR_MASTER_SECRET!,
      baseUrl: 'http://127.0.0.1:9310',
    },
    { tenantId: 'default', widgetId: fixture.widgetId }
  )
);
if (!result) {
  console.error('ISSUE_REFUSED');
  process.exit(1);
}
console.log(
  JSON.stringify({
    url: result.url,
    token: decodeURIComponent(result.url.split('#token=')[1]),
    delivery: result.delivery,
  })
);
