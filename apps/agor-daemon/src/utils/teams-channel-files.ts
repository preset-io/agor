import {
  gatewayFailureCode,
  type InboundFile,
  type InboundSkippedFile,
  TEAMS_MESSAGE_ID,
} from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';
import type { TeamsCatchUpTrigger } from './teams-catch-up.js';
import { type TeamsSendConnector, teamsGraphCacheScope } from './teams-connector-cache.js';

/** Files of a channel mention read over Graph; undefined when it could not be read, so the activity's own list stands. */
export async function readTeamsChannelMessageFiles(args: {
  channel: GatewayChannel;
  connector: TeamsSendConnector;
  threadId: string;
  conversationType: unknown;
  trigger: TeamsCatchUpTrigger | undefined;
  filesEnabled: boolean;
  tenantId: string | undefined;
  signal: AbortSignal;
}): Promise<{ files: InboundFile[]; skipped: InboundSkippedFile[] } | undefined> {
  const { trigger } = args;
  if (
    typeof args.conversationType !== 'string' ||
    args.conversationType.toLowerCase() !== 'channel' ||
    !trigger
  ) {
    return undefined;
  }
  const separator = args.threadId.lastIndexOf('|');
  const channelId = separator > 0 ? args.threadId.slice(0, separator) : '';
  const rootMessageId = args.threadId.slice(separator + 1);
  if (!channelId || !TEAMS_MESSAGE_ID.test(rootMessageId)) return undefined;
  try {
    const result = await args.connector.fetchChannelMessageFiles({
      team: {
        teamId: trigger.team_id,
        teamGroupId: trigger.team_group_id,
        serviceUrl: trigger.service_url,
      },
      channelId,
      rootMessageId,
      messageId: trigger.activity_id,
      filesEnabled: args.filesEnabled,
      cacheScope: teamsGraphCacheScope(args.channel, args.tenantId),
      signal: args.signal,
    });
    return result ?? undefined;
  } catch (error) {
    console.warn(`[gateway.teams.files] event=unavailable code=${gatewayFailureCode(error)}`);
    return undefined;
  }
}
