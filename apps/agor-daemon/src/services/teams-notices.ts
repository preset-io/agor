/**
 * Best-effort Teams system notices (config errors, denials, routing links).
 * They are sent inline through the same fenced address as final replies and
 * are never queued, retried, or allowed to affect the Task they describe.
 */

import type { TeamsConversationAddressRepository } from '@agor/core/db';
import { classifyTeamsSendFailure, gatewayFailureCode } from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';
import type { TeamsSendConnector } from '../utils/teams-connector-cache.js';

const NOTICE_TIMEOUT_MS = 10_000;

export type TeamsNoticeOutcome = 'sent' | 'skipped' | 'failed';

export async function sendTeamsNotice(input: {
  channel: GatewayChannel;
  threadId: string;
  text: string;
  addresses: Pick<TeamsConversationAddressRepository, 'loadFenced' | 'revokeThread'>;
  connector: () => TeamsSendConnector;
  timeoutMs?: number;
}): Promise<TeamsNoticeOutcome> {
  const { channel, threadId } = input;
  if (
    !channel.enabled ||
    channel.channel_type !== 'teams' ||
    (channel.config as Record<string, unknown>).outbound_enabled === false
  ) {
    return 'skipped';
  }
  try {
    const fenced = await input.addresses.loadFenced({ channel, threadId });
    if (!fenced.ok) {
      console.warn(
        `[gateway.teams.notice] event=skipped channel_id=${channel.id} code=${fenced.code}`
      );
      return 'skipped';
    }
    const connector = input.connector();
    const prepared = await connector.prepareSend(fenced.address);
    await prepared.send(
      connector.formatMessage(input.text),
      AbortSignal.timeout(input.timeoutMs ?? NOTICE_TIMEOUT_MS)
    );
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
      `[gateway.teams.notice] event=send_failed channel_id=${channel.id} outcome=${outcome.kind} code=${code}`
    );
    return 'failed';
  }
}
