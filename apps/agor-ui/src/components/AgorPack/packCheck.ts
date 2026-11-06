/**
 * The "Check before moving/importing" report, built from the export preflight
 * (moving) or an uploaded pack's receipt (importing). Pure, so the report
 * component and the Finish setup panel agree on what needs reconnecting.
 */

import {
  type AgorPackFlaggedSession,
  type AgorPackImport,
  type AgorPackPreflightTeammate,
  type AgorPackRequirements,
  type AgorPackSessionMode,
  type AgorPackTeammateSummary,
  agorPackPrivateHost,
} from '@agor/core/types';
import { type Branch, hasMinimumRole, ROLES, type User } from '@agor-live/client';
import { PACK_COPY } from './packCopy';

export interface PackCheckCounts {
  teammates: number;
  boards: number;
  artifacts: number;
  docs: number;
  schedules: number;
  sessions: number;
}

export interface PackCheckBlocker {
  teammate: string;
  kind: 'docker' | 'host' | 'attachments';
  /** The private host for `host`. */
  host?: string;
  /** Attachments too large to move, for `attachments`. */
  count?: number;
}

export interface PackCheck {
  counts: PackCheckCounts;
  /** Chips: the agentic tool account first, then apps, channels, and variables. */
  reconnect: string[];
  wont: PackCheckBlocker[];
  /** Sessions the secret scan flagged (titles when known, from the preflight). */
  flagged: Array<Pick<AgorPackFlaggedSession, 'session_id' | 'title'>>;
  flaggedCount: number;
}

const TOOL_ACCOUNTS: Record<string, string> = {
  'claude-code': PACK_COPY.rcClaude,
  codex: 'OpenAI account',
  gemini: 'Gemini account',
  copilot: 'GitHub Copilot account',
  cursor: 'Cursor account',
  opencode: 'OpenCode account',
};

/** "Claude account" for claude-code, the tool name otherwise. */
export function toolAccountLabel(tool: string): string {
  return TOOL_ACCOUNTS[tool] ?? `${tool} account`;
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Reconnect chips for a set of requirements, deduplicated, account first. */
/** One thing to reconnect after a move; the Check report and Finish setup both list these. */
export type ReconnectItem =
  | { kind: 'account'; key: string; label: string; tool: string }
  | { kind: 'mcp'; key: string; label: string; server: AgorPackRequirements['mcp_servers'][number] }
  | {
      kind: 'channel';
      key: string;
      label: string;
      channel: AgorPackRequirements['gateway_channels'][number];
    }
  | { kind: 'env'; key: string; label: string; env: AgorPackRequirements['env_vars'][number] };

/** What to reconnect, deduplicated: accounts first, then apps, channels, variables. */
export function reconnectItems(requirements: AgorPackRequirements[]): ReconnectItem[] {
  const items = new Map<string, ReconnectItem>();
  const add = (item: ReconnectItem) => {
    if (!items.has(item.key)) items.set(item.key, item);
  };
  for (const req of requirements) {
    for (const tool of req.agentic_tools) {
      add({ kind: 'account', key: `account:${tool}`, label: toolAccountLabel(tool), tool });
    }
  }
  for (const req of requirements) {
    for (const server of req.mcp_servers) {
      add({
        kind: 'mcp',
        key: `mcp:${server.name}`,
        label: server.display_name ?? server.name,
        server,
      });
    }
  }
  for (const req of requirements) {
    for (const channel of req.gateway_channels) {
      add({
        kind: 'channel',
        key: `channel:${channel.channel_type}:${channel.name}`,
        label: capitalize(channel.channel_type),
        channel,
      });
    }
  }
  for (const req of requirements) {
    for (const env of req.env_vars)
      add({ kind: 'env', key: `env:${env.name}`, label: env.name, env });
  }
  return [...items.values()];
}

/** Reconnect chips for a set of requirements. */
export function reconnectLabels(requirements: AgorPackRequirements[]): string[] {
  return [...new Set(reconnectItems(requirements).map((item) => item.label))];
}

/** Docker-style environments and private hosts, per teammate. */
export function blockers(
  teammate: string,
  environment: AgorPackTeammateSummary['environment'],
  requirements: AgorPackRequirements
): PackCheckBlocker[] {
  const out: PackCheckBlocker[] = [];
  if (environment.variants.some((variant) => variant.status === 'wont_run_in_cloud')) {
    out.push({ teammate, kind: 'docker' });
  }
  const hosts = new Set<string>();
  for (const variant of environment.variants) {
    if (variant.status === 'needs_webhook' && variant.match) hosts.add(variant.match);
  }
  for (const server of requirements.mcp_servers) {
    const host = agorPackPrivateHost(server.url);
    if (host) hosts.add(host);
  }
  for (const host of hosts) out.push({ teammate, kind: 'host', host });
  return out;
}

/** Sessions an export includes for a history choice. */
function sessionsFor(
  teammate: AgorPackPreflightTeammate,
  mode: AgorPackSessionMode,
  includeOthers: boolean
): { count: number; bytes: number } {
  if (mode === 'none') return { count: 0, bytes: 0 };
  const recent = mode !== 'all';
  const pick = (tally: AgorPackPreflightTeammate['sessions']) =>
    (recent ? tally.recent_own : tally.own) +
    (includeOthers ? (recent ? tally.recent_others : tally.others) : 0);
  return { count: pick(teammate.sessions), bytes: pick(teammate.session_bytes) };
}

export function flaggedFor(
  teammate: AgorPackPreflightTeammate,
  mode: AgorPackSessionMode,
  includeOthers: boolean
): AgorPackFlaggedSession[] {
  if (mode === 'none') return [];
  return teammate.flagged_sessions.filter(
    (session) => (includeOthers || session.own) && (mode === 'all' || session.recent)
  );
}

/** Count and estimated size of an export for a history choice. */
export function exportEstimate(
  preflight: AgorPackPreflightTeammate[],
  mode: AgorPackSessionMode,
  includeOthers: boolean
): { sessions: number; bytes: number } {
  let sessions = 0;
  let bytes = 0;
  for (const teammate of preflight) {
    const picked = sessionsFor(teammate, mode, includeOthers);
    sessions += picked.count;
    bytes += picked.bytes + teammate.other_bytes;
  }
  return { sessions, bytes };
}

export function checkFromPreflight(
  preflight: AgorPackPreflightTeammate[],
  mode: AgorPackSessionMode,
  includeOthers: boolean,
  leaveOutFlagged: boolean
): PackCheck {
  const flagged = preflight.flatMap((teammate) => flaggedFor(teammate, mode, includeOthers));
  return {
    counts: {
      teammates: preflight.length,
      boards: preflight.filter((teammate) => teammate.board).length,
      artifacts: preflight.reduce((sum, teammate) => sum + teammate.artifacts, 0),
      docs: preflight.reduce((sum, teammate) => sum + teammate.knowledge_documents, 0),
      schedules: preflight.reduce((sum, teammate) => sum + teammate.schedules, 0),
      sessions:
        exportEstimate(preflight, mode, includeOthers).sessions -
        (leaveOutFlagged ? flagged.length : 0),
    },
    reconnect: reconnectLabels(preflight.map((teammate) => teammate.requirements)),
    wont: preflight.flatMap((teammate) => {
      const large = (teammate.large_attachments ?? []).filter(
        (file) => mode !== 'none' && (includeOthers || file.own) && (mode === 'all' || file.recent)
      ).length;
      return [
        ...blockers(teammate.display_name, teammate.environment, teammate.requirements),
        ...(large
          ? [{ teammate: teammate.display_name, kind: 'attachments' as const, count: large }]
          : []),
      ];
    }),
    flagged,
    flaggedCount: flagged.length,
  };
}

export function checkFromReceipt(
  receipt: AgorPackImport,
  keys: string[],
  skipFlagged: boolean
): PackCheck {
  const teammates = receipt.manifest.teammates.filter((teammate) => keys.includes(teammate.key));
  const flaggedCount = teammates.reduce(
    (sum, teammate) => sum + (teammate.sections.sessions?.flagged ?? 0),
    0
  );
  return {
    counts: {
      teammates: teammates.length,
      boards: teammates.filter((teammate) => teammate.sections.board).length,
      artifacts: teammates.reduce((sum, teammate) => sum + (teammate.sections.artifacts ?? 0), 0),
      docs: teammates.reduce(
        (sum, teammate) => sum + (teammate.sections.knowledge?.documents ?? 0),
        0
      ),
      schedules: teammates.reduce((sum, teammate) => sum + (teammate.sections.schedules ?? 0), 0),
      sessions:
        teammates.reduce((sum, teammate) => sum + (teammate.sections.sessions?.count ?? 0), 0) -
        (skipFlagged ? flaggedCount : 0),
    },
    reconnect: reconnectLabels(teammates.map((teammate) => teammate.requirements)),
    wont: teammates.flatMap((teammate) =>
      blockers(teammate.display_name, teammate.environment, teammate.requirements)
    ),
    flagged: [],
    flaggedCount,
  };
}

/** Members export or move their own teammates (primary owner); admins anyone's. */
export function canExportTeammate(user: User | null | undefined, branch: Branch): boolean {
  if (!user) return false;
  if (hasMinimumRole(user.role, ROLES.ADMIN)) return true;
  return (branch.primary_owner_user_id ?? branch.created_by) === user.user_id;
}
