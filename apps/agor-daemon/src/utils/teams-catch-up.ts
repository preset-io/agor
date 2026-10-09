import type { GatewayConnector, TeamsProviderHistoryContext } from '@agor/core/gateway';
import type { GatewayChannel, TeamsCatchUpConfig } from '@agor/core/types';
import { withTeamsConfigDefaults } from '@agor/core/types';
import {
  fetchGatewayCatchUp,
  formatGatewayCatchUpFallbackPrompt,
  GatewayCatchUpError,
} from './gateway-catch-up.js';

const TEAMS_PROVIDER_LABEL = 'Microsoft Teams';
const TEAMS_MESSAGE_ID = /^\d{1,20}$/;

/** Verified trigger coordinates the Teams worker passes to GatewayService; never persisted. */
export interface TeamsCatchUpTrigger {
  activity_id: string;
  timestamp: string;
  service_url: string;
  team_id: string | null;
  team_group_id: string | null;
}

function isBefore(left: string, right: string): boolean {
  return BigInt(left) < BigInt(right);
}

// On failure the mention is admitted marked `history_status` with no cursor, so the interval is re-read next time.
export async function prepareTeamsCatchUp(args: {
  channel: GatewayChannel;
  connector: () => GatewayConnector | undefined;
  threadId: string;
  currentText: string;
  conversationType: unknown;
  trigger: TeamsCatchUpTrigger | undefined;
  cursor: string | null | undefined;
  tenantId: string | undefined;
}): Promise<{ prompt: string; cursor?: string }> {
  const catchUp = withTeamsConfigDefaults(args.channel.config).catch_up as TeamsCatchUpConfig;
  // Personal and group chats have no history read, like Discord DMs.
  if (
    catchUp.mode !== 'best_effort' ||
    typeof args.conversationType !== 'string' ||
    args.conversationType.toLowerCase() !== 'channel' ||
    !args.trigger
  ) {
    return { prompt: args.currentText };
  }
  const deadline = AbortSignal.timeout(catchUp.request_timeout_ms);
  try {
    const trigger = args.trigger;
    if (!TEAMS_MESSAGE_ID.test(trigger.activity_id)) {
      throw new GatewayCatchUpError('malformed', 'Teams mention had no numeric message ID');
    }
    // A legacy non-numeric cursor carries no interval; bootstrap from the root instead.
    const cursor = args.cursor && TEAMS_MESSAGE_ID.test(args.cursor) ? args.cursor : undefined;
    if (cursor && !isBefore(cursor, trigger.activity_id)) {
      throw new GatewayCatchUpError('malformed', 'Teams cursor is not before the live mention');
    }
    const connector = args.connector();
    if (!connector) throw new GatewayCatchUpError('unsupported', 'Teams history is unavailable');
    const providerContext: TeamsProviderHistoryContext = {
      teamId: args.trigger.team_id,
      teamGroupId: args.trigger.team_group_id,
      serviceUrl: args.trigger.service_url,
      triggerTimestamp: args.trigger.timestamp,
      cacheScope: args.tenantId
        ? {
            agorTenantId: args.tenantId,
            gatewayChannelId: args.channel.id,
            providerConfigGeneration: args.channel.provider_config_generation,
          }
        : null,
    };
    return await fetchGatewayCatchUp({
      connector,
      request: {
        threadId: args.threadId,
        ...(cursor ? { afterProviderCursor: cursor } : {}),
        throughProviderCursor: trigger.activity_id,
        triggerProviderCursor: trigger.activity_id,
        providerContext,
        signal: deadline,
      },
      provider: TEAMS_PROVIDER_LABEL,
      currentText: args.currentText,
      maxPromptBytes: catchUp.max_prompt_bytes,
      trimOldestToFit: true,
    });
  } catch (error) {
    const code =
      error instanceof GatewayCatchUpError
        ? error.kind
        : deadline.aborted
          ? 'timeout'
          : 'provider_unavailable';
    console.warn(`[gateway.teams.catch_up] event=fallback code=${code}`);
    return {
      prompt: formatGatewayCatchUpFallbackPrompt({
        provider: TEAMS_PROVIDER_LABEL,
        threadId: args.threadId,
        currentText: args.currentText,
        historyStatus: 'unavailable',
      }),
    };
  }
}
