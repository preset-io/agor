import type { FencedTeamsAddress } from '@agor/core/db';
import type { TeamsConnector, TeamsTeamChannel } from '@agor/core/gateway';
import type { GatewayChannel, TeamsGatewayConfig } from '@agor/core/types';
import { teamsGraphCacheScope } from './teams-connector-cache.js';

/** Teams whose channels are listed per call; each listing is one Bot Connector request. */
export const TEAMS_ANCHOR_TEAMS = 5;

type TeamsAnchor = Extract<FencedTeamsAddress, { ok: true }>;

/** Allowlisted channels of each allowlisted anchor team; a team Teams cannot list contributes none. */
export async function listTeamsAnchoredChannels(args: {
  channel: GatewayChannel;
  anchors: TeamsAnchor[];
  connector: Pick<TeamsConnector, 'listTeamChannels'>;
  tenantId: string | undefined;
}): Promise<Array<{ anchor: TeamsAnchor; channels: TeamsTeamChannel[] }>> {
  const config = args.channel.config as TeamsGatewayConfig;
  const allowedTeams = config.allowed_team_ids ?? [];
  const allowedChannels = config.allowed_channel_ids ?? [];
  const reachable: Array<{ anchor: TeamsAnchor; channels: TeamsTeamChannel[] }> = [];
  for (const anchor of args.anchors.slice(0, TEAMS_ANCHOR_TEAMS)) {
    const teamId = anchor.row.team_id;
    if (!teamId || (allowedTeams.length > 0 && !allowedTeams.includes(teamId))) continue;
    const channels = await args.connector
      .listTeamChannels({
        teamId,
        serviceUrl: anchor.address.serviceUrl as string,
        cacheScope: teamsGraphCacheScope(args.channel, args.tenantId),
      })
      .catch(() => []);
    reachable.push({
      anchor,
      channels: channels.filter(
        (candidate) => allowedChannels.length === 0 || allowedChannels.includes(candidate.id)
      ),
    });
  }
  return reachable;
}
