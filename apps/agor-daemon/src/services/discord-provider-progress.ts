import type { GatewayConnector } from '@agor/core/gateway';
import {
  type DiscordNonceRecoveryWindow,
  type DiscordProgressCleanupDebt,
  discordProgressNonceSeed,
  isDiscordSnowflake,
} from '@agor/core/gateway';
import type {
  GatewayDiscordProgressActionParams,
  TaskID,
  ThreadSessionMapID,
} from '@agor/core/types';
import { isDiscordUnknownMessageError } from './discord-provider-action-failure.js';

export interface DiscordProgressConnector extends GatewayConnector {
  triggerTyping(threadId: string): Promise<void>;
  sendMessageRecoverable(
    req: { threadId: string; text: string; metadata?: Record<string, unknown> },
    options: {
      recoveryWindow?: DiscordNonceRecoveryWindow;
      signal?: AbortSignal;
      beforeProviderCall?: () => Promise<void>;
    }
  ): Promise<string>;
}

export type DiscordProgressTransportResult =
  | { outcome: 'upserted'; providerMessageId: string }
  | { outcome: 'cleaned' | 'noop' };

export function isDiscordProgressConnector(
  connector: GatewayConnector
): connector is DiscordProgressConnector {
  return (
    typeof (connector as Partial<DiscordProgressConnector>).triggerTyping === 'function' &&
    typeof (connector as Partial<DiscordProgressConnector>).sendMessageRecoverable === 'function' &&
    typeof connector.deleteMessage === 'function'
  );
}

/** Fixed launch copy. No provider/user/error/tool-input text reaches this seam. */
export function renderDiscordProgress(params: GatewayDiscordProgressActionParams): string {
  switch (params.state) {
    case 'queued':
      return 'Queued in Agor…';
    case 'working':
      return params.tool_name ? `Using ${params.tool_name}…` : 'Working in Agor…';
    case 'failed':
      return 'Agor ran into an error.';
    case 'done':
      return '';
  }
}

/** Execute one already-admitted progress transport mutation on the exact owner client. */
export async function executeDiscordProgressTransport(input: {
  connector: DiscordProgressConnector;
  threadId: string;
  mappingId: ThreadSessionMapID;
  taskId: TaskID;
  params: GatewayDiscordProgressActionParams;
  providerMessageId?: string;
  recoveryWindow?: DiscordNonceRecoveryWindow;
  beforeProviderCall?: () => Promise<void>;
}): Promise<DiscordProgressTransportResult> {
  const { connector, providerMessageId } = input;
  if (input.params.state === 'done') {
    // Terminal cleanup is executed only through the separately fenced cleanup
    // debt path; this upsert helper never performs a delete.
    return { outcome: 'noop' };
  }

  const result = await connector.sendMessageRecoverable(
    {
      threadId: input.threadId,
      text: renderDiscordProgress(input.params),
      metadata: providerMessageId
        ? { discord_update_message_id: providerMessageId }
        : { discord_nonce_seed: discordProgressNonceSeed(input.mappingId, input.taskId) },
    },
    {
      ...(input.recoveryWindow && !providerMessageId
        ? { recoveryWindow: input.recoveryWindow }
        : {}),
      ...(input.beforeProviderCall ? { beforeProviderCall: input.beforeProviderCall } : {}),
    }
  );
  return { outcome: 'upserted', providerMessageId: result };
}

/**
 * Resolve one uncertain create by its stable task nonce. This may briefly
 * create the fixed progress row when no prior create reached Discord; deletion
 * is a separate freshly fenced side effect owned by the caller.
 */
export async function resolveDiscordProgressCleanupCoordinate(input: {
  connector: DiscordProgressConnector;
  threadId: string;
  mappingId: ThreadSessionMapID;
  debt: DiscordProgressCleanupDebt;
  recoveryWindow: DiscordNonceRecoveryWindow;
  beforeProviderCall?: () => Promise<void>;
}): Promise<string> {
  if (input.debt.providerMessageId) return input.debt.providerMessageId;
  const providerMessageId = await input.connector.sendMessageRecoverable(
    {
      threadId: input.threadId,
      text: 'Working in Agor…',
      metadata: {
        discord_nonce_seed: discordProgressNonceSeed(input.mappingId, input.debt.taskId),
      },
    },
    {
      recoveryWindow: input.recoveryWindow,
      ...(input.beforeProviderCall ? { beforeProviderCall: input.beforeProviderCall } : {}),
    }
  );
  if (!isDiscordSnowflake(providerMessageId)) {
    throw new Error('Discord progress cleanup returned an invalid coordinate');
  }
  return providerMessageId;
}

/** Delete one resolved coordinate; unknown-message is idempotent success. */
export async function deleteDiscordProgressCoordinate(input: {
  connector: DiscordProgressConnector;
  threadId: string;
  providerMessageId: string;
}): Promise<void> {
  try {
    await input.connector.deleteMessage!({
      threadId: input.threadId,
      messageId: input.providerMessageId,
    });
  } catch (error) {
    if (!isDiscordUnknownMessageError(error)) throw error;
  }
}
