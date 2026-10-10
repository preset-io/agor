import type { FencedTeamsAddress } from '@agor/core/db';
import type { TeamsConnector, TeamsTeamChannel } from '@agor/core/gateway';
import type { GatewayChannel, TeamsGatewayConfig } from '@agor/core/types';
import { teamsGraphCacheScope } from './teams-connector-cache.js';

/** Teams whose channels are listed per call; each listing is one bounded Bot Connector request. */
export const TEAMS_ANCHOR_TEAMS = 5;

type TeamsAnchor = Extract<FencedTeamsAddress, { ok: true }>;

/** Allowlisted, unmarked channels of each anchor's team, listed in parallel; a failed listing contributes none. */
export function listTeamsAnchoredChannels(args: {
  channel: GatewayChannel;
  anchors: TeamsAnchor[];
  connector: Pick<TeamsConnector, 'listTeamChannels'>;
  tenantId: string | undefined;
  /** Conversations stored as private or shared. */
  excluded?: Set<string>;
}): Promise<Array<{ anchor: TeamsAnchor; channels: TeamsTeamChannel[] }>> {
  const allowedChannels = (args.channel.config as TeamsGatewayConfig).allowed_channel_ids ?? [];
  return Promise.all(
    args.anchors.map(async (anchor) => {
      const channels = await args.connector
        .listTeamChannels({
          teamId: anchor.row.team_id as string,
          serviceUrl: anchor.address.serviceUrl as string,
          cacheScope: teamsGraphCacheScope(args.channel, args.tenantId),
        })
        .catch(() => []);
      return {
        anchor,
        channels: channels.filter(
          (candidate) =>
            !args.excluded?.has(candidate.id) &&
            (allowedChannels.length === 0 || allowedChannels.includes(candidate.id))
        ),
      };
    })
  );
}
