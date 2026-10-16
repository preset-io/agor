import {
  type Database,
  GatewayChannelRepository,
  type GatewayChatCommandInput,
  GatewayChatCommandRepository,
  generateId,
  TaskRepository,
} from '@agor/core/db';
import { seedQueue } from './task-queue-fixture.js';

export async function gatewayCommandFixture(db: Database) {
  const seed = await seedQueue(db);
  const channel = await new GatewayChannelRepository(db).create({
    name: 'Commands',
    channel_type: 'slack',
    enabled: true,
    target_branch_id: seed.branch.branch_id,
    agor_user_id: seed.owner.user_id,
    config: { bot_token: 'test-command-token', app_token: 'test-command-app-token' },
    created_by: seed.owner.user_id,
  });
  const commands = new GatewayChatCommandRepository(db);
  const input: GatewayChatCommandInput = {
    channelId: channel.id,
    threadId: 'thread',
    sessionId: seed.session.session_id,
    userId: seed.owner.user_id,
    command: 'stop-clear',
    providerEventId: generateId(),
    expected: await commands.snapshot(seed.session.session_id),
  };
  return { seed, channel, commands, input, tasks: new TaskRepository(db) };
}
