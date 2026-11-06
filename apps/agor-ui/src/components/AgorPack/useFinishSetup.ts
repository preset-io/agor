/**
 * Finish setup for an imported teammate: what still needs reconnecting (from
 * the requirements its import recorded on the branch) and whether each item
 * is done for the current user, plus its schedules' waiting state.
 */

import type { AgorPackRequirements } from '@agor/core/types';
import type {
  AgenticToolName,
  AgorClient,
  Branch,
  GatewayChannel,
  MCPServer,
  Schedule,
  User,
} from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  selectGatewayChannelById,
  selectMcpServerById,
  selectUserAuthenticatedMcpServerIds,
} from '../../store/selectors';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { hasConfiguredCredentialFor } from '../OnboardingBanners/bannerLogic';
import { reconnectItems } from './packCheck';
import { fill, PACK_COPY } from './packCopy';

export interface FinishSetupItem {
  key: string;
  kind: 'account' | 'mcp' | 'env' | 'channel';
  label: string;
  /** "Used by the Morning brief schedule" lines. */
  usedBy: string[];
  done: boolean;
  tool?: string;
  catalogEntryName?: string | null;
  envName?: string;
  envScope?: 'global' | 'session' | null;
}

export interface FinishSetupState {
  name: string;
  items: FinishSetupItem[];
  done: number;
  total: number;
  schedules: Schedule[];
  /** The first item a schedule still waits for (null when it can run). */
  waitingFor: (schedule: Schedule) => string | null;
  setSchedule: (schedule: Schedule) => void;
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** "schedule:Morning brief" → "Used by the Morning brief schedule". */
function usedByLine(use: string): string | null {
  const [kind, ...rest] = use.split(':');
  const what = rest.join(':');
  if (kind === 'schedule') return fill(PACK_COPY.fsUsedBy, { schedule: what });
  if (kind === 'gateway') return `Used by ${capitalize(what)}`;
  if (kind === 'mcp') return `Used by ${what}`;
  if (kind === 'artifact') return `Used by the ${what} artifact`;
  return null;
}

/** What an imported teammate still needs reconnected, account first. */
export function finishSetupItems(input: {
  requirements: AgorPackRequirements;
  branchId: string;
  name: string;
  user: User | null | undefined;
  credentialFor: (tool: string) => boolean;
  servers: MCPServer[];
  authedIds: Set<string>;
  channels: GatewayChannel[];
}): FinishSetupItem[] {
  const { requirements, name, user, servers, authedIds, channels } = input;
  const userEnv = (user?.env_vars ?? {}) as Record<string, { set?: boolean }>;
  // The same items, in the same order, as the Check report's reconnect chips.
  const out: FinishSetupItem[] = [];
  for (const item of reconnectItems([requirements])) {
    if (item.kind === 'account') {
      out.push({
        key: item.key,
        kind: 'account',
        tool: item.tool,
        label: item.label,
        usedBy: [fill(PACK_COPY.fsClaudeUse, { name })],
        done: input.credentialFor(item.tool),
      });
    } else if (item.kind === 'mcp') {
      const required = item.server;
      const server =
        servers.find(
          (s) => required.catalog_entry_name && s.catalog_entry_name === required.catalog_entry_name
        ) ?? servers.find((s) => s.name === required.name);
      out.push({
        key: item.key,
        kind: 'mcp',
        label: item.label,
        catalogEntryName: required.catalog_entry_name,
        usedBy: required.used_by.map(usedByLine).filter((line): line is string => !!line),
        done: Boolean(server && server.enabled !== false && !mcpServerNeedsAuth(server, authedIds)),
      });
    } else if (item.kind === 'channel') {
      const required = item.channel;
      out.push({
        key: item.key,
        kind: 'channel',
        label: item.label,
        usedBy: [required.name],
        done: channels.some(
          (channel) =>
            channel.target_branch_id === input.branchId &&
            channel.channel_type === required.channel_type &&
            channel.enabled
        ),
      });
    } else {
      out.push({
        key: item.key,
        kind: 'env',
        label: item.label,
        envName: item.env.name,
        envScope: item.env.scope,
        usedBy: item.env.used_by.map(usedByLine).filter((line): line is string => !!line),
        done: Boolean(userEnv[item.env.name]?.set),
      });
    }
  }
  return out;
}

export function useFinishSetup(
  branch: Branch | null | undefined,
  client: AgorClient | null | undefined,
  currentUser: User | null | undefined
): FinishSetupState | null {
  const requirements = branch?.agor_pack?.imported_from?.requirements as
    | AgorPackRequirements
    | undefined;
  const mcpServerById = useAgorStore(selectMcpServerById);
  const authedIds = useAgorStore(selectUserAuthenticatedMcpServerIds);
  const channelById = useAgorStore(selectGatewayChannelById);
  const toolSettings = useAgorStore((state) => state.agenticToolSettingsByName);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const branchId = branch?.branch_id;

  useEffect(() => {
    if (!client || !branchId || !requirements) return;
    let cancelled = false;
    client
      .service('schedules')
      .find({ query: { branch_id: branchId, $sort: { created_at: 1 } } })
      .then((result: Schedule[] | { data: Schedule[] }) => {
        if (!cancelled) setSchedules(Array.isArray(result) ? result : result.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, branchId, requirements]);

  const name = branch ? (getTeammateConfig(branch)?.displayName ?? branch.name) : '';
  const items = useMemo<FinishSetupItem[]>(
    () =>
      requirements && branch
        ? finishSetupItems({
            requirements,
            branchId: branch.branch_id,
            name,
            user: currentUser,
            credentialFor: (tool) =>
              hasConfiguredCredentialFor(
                currentUser,
                tool as AgenticToolName,
                toolSettings.get(tool as never)
              ),
            servers: [...mcpServerById.values()],
            authedIds,
            channels: [...channelById.values()],
          })
        : [],
    [requirements, branch, name, currentUser, toolSettings, mcpServerById, authedIds, channelById]
  );

  const waitingFor = useCallback(
    (schedule: Schedule) => {
      const use = `schedule:${schedule.name}`;
      const app = items.find(
        (item) =>
          !item.done &&
          item.kind === 'mcp' &&
          requirements?.mcp_servers.some(
            (server) =>
              (server.display_name ?? server.name) === item.label && server.used_by.includes(use)
          )
      );
      if (app) return app.label;
      const tool = schedule.agentic_tool_config?.agentic_tool;
      return (
        items.find((item) => !item.done && item.kind === 'account' && item.tool === tool)?.label ??
        null
      );
    },
    [items, requirements]
  );
  const setSchedule = useCallback(
    (updated: Schedule) =>
      setSchedules((prev) =>
        prev.map((s) => (s.schedule_id === updated.schedule_id ? updated : s))
      ),
    []
  );

  if (!requirements || !branch) return null;
  return {
    name,
    items,
    done: items.filter((item) => item.done).length,
    total: items.length,
    schedules,
    waitingFor,
    setSchedule,
  };
}
