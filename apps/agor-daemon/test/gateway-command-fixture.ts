import {
  type Database,
  GatewayChannelRepository,
  type GatewayChatCommandInput,
  GatewayChatCommandRepository,
  generateId,
  TaskRepository,
} from '@agor/core/db';
import type { GatewayChannel } from '@agor/core/types';
import { seedQueue } from './task-queue-fixture.js';

export async function gatewayCommandFixture(
  db: Database,
  channelOptions: Partial<
    Pick<GatewayChannel, 'channel_type' | 'config' | 'provider_installation_id'>
  > = {}
) {
  const seed = await seedQueue(db);
  const channel = await new GatewayChannelRepository(db).create({
    name: 'Commands',
    channel_type: 'slack',
    enabled: true,
    target_branch_id: seed.branch.branch_id,
    agor_user_id: seed.owner.user_id,
    config: { bot_token: 'test-command-token', app_token: 'test-command-app-token' },
    created_by: seed.owner.user_id,
    ...channelOptions,
  });
  const commands = new GatewayChatCommandRepository(db);
  const input = {
    channelId: channel.id,
    threadId: 'thread',
    sessionId: seed.session.session_id,
    userId: seed.owner.user_id,
    command: 'stop-clear',
    providerEventId: generateId(),
    expected: await commands.snapshot(seed.session.session_id),
  } satisfies GatewayChatCommandInput;
  return { seed, channel, commands, input, tasks: new TaskRepository(db) };
}
