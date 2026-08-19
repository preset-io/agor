import type { GatewayDiscordProgressActionParams } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  deleteDiscordProgressCoordinate,
  executeDiscordProgressTransport,
  renderDiscordProgress,
  resolveDiscordProgressCleanupCoordinate,
} from './discord-provider-progress.js';

const mappingId = '01927f9d-1000-7000-8000-000000000002' as never;
const taskId = '01927f9d-1000-7000-8000-000000000004' as never;

function connector() {
  const sendMessage = vi.fn(
    async (_request: { threadId: string; text: string; metadata?: Record<string, unknown> }) =>
      '823456789012345678'
  );
  return {
    channelType: 'discord' as const,
    sendMessage,
    sendMessageRecoverable: vi.fn(async (request: Parameters<typeof sendMessage>[0]) =>
      sendMessage(request)
    ),
    deleteMessage: vi.fn(async () => undefined),
    triggerTyping: vi.fn(async () => undefined),
  };
}

function input(params: GatewayDiscordProgressActionParams, providerMessageId?: string) {
  return {
    connector: connector(),
    threadId: 'discord:723456789012345678',
    mappingId,
    taskId,
    params,
    ...(providerMessageId ? { providerMessageId } : {}),
  };
}

describe('Discord provider progress transport', () => {
  it('uses fixed copy and a stable create nonce seed across uncertain replay', async () => {
    const first = input({ state: 'working', revision: 1, tool_name: 'Grep' });
    const replay = input({ state: 'working', revision: 1, tool_name: 'Grep' });
    await expect(executeDiscordProgressTransport(first)).resolves.toEqual({
      outcome: 'upserted',
      providerMessageId: '823456789012345678',
    });
    await expect(executeDiscordProgressTransport(replay)).resolves.toMatchObject({
      outcome: 'upserted',
    });
    expect(first.connector.triggerTyping).not.toHaveBeenCalled();
    expect(first.connector.sendMessage).toHaveBeenCalledWith({
      threadId: first.threadId,
      text: 'Using Grep…',
      metadata: {
        discord_nonce_seed: `discord-progress:${mappingId}:${taskId}`,
      },
    });
    expect(replay.connector.sendMessage.mock.calls[0]?.[0].metadata).toEqual(
      first.connector.sendMessage.mock.calls[0]?.[0].metadata
    );
    expect(renderDiscordProgress({ state: 'failed', revision: 2 })).toBe('Agor ran into an error.');
  });

  it('edits one handle without typing for failure', async () => {
    const current = input({ state: 'failed', revision: 2 }, '823456789012345678');
    await executeDiscordProgressTransport(current);
    expect(current.connector.triggerTyping).not.toHaveBeenCalled();
    expect(current.connector.sendMessage).toHaveBeenCalledWith({
      threadId: current.threadId,
      text: 'Agor ran into an error.',
      metadata: { discord_update_message_id: '823456789012345678' },
    });
  });

  it('leaves terminal deletion to the separately fenced cleanup path', async () => {
    const current = input({ state: 'done', revision: 3 }, '823456789012345678');
    await expect(executeDiscordProgressTransport(current)).resolves.toEqual({ outcome: 'noop' });
    expect(current.connector.deleteMessage).not.toHaveBeenCalled();
    expect(current.connector.sendMessage).not.toHaveBeenCalled();
    const missing = input({ state: 'done', revision: 4 });
    await expect(executeDiscordProgressTransport(missing)).resolves.toEqual({
      outcome: 'noop',
    });
  });

  it('resolves uncertain creates with the stable task nonce before idempotent cleanup', async () => {
    const current = input({ state: 'done', revision: 3 });
    const debt = { taskId };
    await expect(
      resolveDiscordProgressCleanupCoordinate({
        connector: current.connector,
        threadId: current.threadId,
        mappingId,
        debt,
        recoveryWindow: { after: '100', before: '999999999999999999' },
      })
    ).resolves.toBe('823456789012345678');
    expect(current.connector.sendMessage).toHaveBeenCalledWith({
      threadId: current.threadId,
      text: 'Working in Agor…',
      metadata: { discord_nonce_seed: `discord-progress:${mappingId}:${taskId}` },
    });
    current.connector.deleteMessage.mockRejectedValueOnce({
      status: 404,
      rawError: { code: 10008 },
    });
    await expect(
      deleteDiscordProgressCoordinate({
        connector: current.connector,
        threadId: current.threadId,
        providerMessageId: '823456789012345678',
      })
    ).resolves.toBeUndefined();
  });
});
