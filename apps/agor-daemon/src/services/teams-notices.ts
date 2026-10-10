/**
 * Best-effort Teams system notices (config errors, denials, routing links) and
 * typing indicators. They are sent inline through the same fenced address as
 * final replies and are never queued, retried, or allowed to affect the Task
 * they describe.
 */

import type { TeamsConversationAddressRepository } from '@agor/core/db';
import {
  classifyTeamsSendFailure,
  gatewayFailureCode,
  type PreparedTeamsSend,
} from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';
import type { TeamsSendConnector } from '../utils/teams-connector-cache.js';

const NOTICE_TIMEOUT_MS = 10_000;

export type TeamsNoticeOutcome = 'sent' | 'skipped' | 'failed';

export interface TeamsDirectSendInput {
  channel: GatewayChannel;
  threadId: string;
  addresses: Pick<TeamsConversationAddressRepository, 'loadFenced' | 'revokeThread'>;
  connector: () => TeamsSendConnector;
  timeoutMs?: number;
}

/** One fenced, unqueued send through the stored address. */
async function sendTeamsDirect(
  input: TeamsDirectSendInput,
  event: 'notice' | 'typing',
  effect: (
    prepared: PreparedTeamsSend,
    connector: TeamsSendConnector,
    signal: AbortSignal
  ) => Promise<unknown>
): Promise<TeamsNoticeOutcome> {
  const { channel, threadId } = input;
  if (!channel.enabled || channel.channel_type !== 'teams') return 'skipped';
  try {
    const fenced = await input.addresses.loadFenced({ channel, threadId });
    if (!fenced.ok) {
      console.warn(
        `[gateway.teams.${event}] event=skipped channel_id=${channel.id} code=${fenced.code}`
      );
      return 'skipped';
    }
    const connector = input.connector();
    const prepared = await connector.prepareSend(fenced.address);
    await effect(prepared, connector, AbortSignal.timeout(input.timeoutMs ?? NOTICE_TIMEOUT_MS));
    return 'sent';
  } catch (error) {
    const outcome = classifyTeamsSendFailure(error);
    if (outcome.kind === 'revoked') {
      await input.addresses.revokeThread(channel.id, threadId, outcome.reason).catch(() => 0);
    }
    if (outcome.kind === 'retry' && outcome.refreshToken) {
      try {
        input.connector().invalidateTokens();
      } catch {
        // Token eviction is an optimization; the next prepare fetches a token anyway.
      }
    }
    const code = outcome.kind === 'ambiguous' ? gatewayFailureCode(error) : outcome.code;
    console.warn(
      `[gateway.teams.${event}] event=send_failed channel_id=${channel.id} outcome=${outcome.kind} code=${code}`
    );
    return 'failed';
  }
}

export function sendTeamsNotice(
  input: TeamsDirectSendInput & { text: string }
): Promise<TeamsNoticeOutcome> {
  return sendTeamsDirect(input, 'notice', (prepared, connector, signal) =>
    prepared.send(connector.formatMessage(input.text), signal)
  );
}

export function sendTeamsTyping(input: TeamsDirectSendInput): Promise<TeamsNoticeOutcome> {
  return sendTeamsDirect(input, 'typing', (prepared, _connector, signal) =>
    prepared.sendTyping(signal)
  );
}
