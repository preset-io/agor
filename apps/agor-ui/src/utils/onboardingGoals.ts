import type { UserPreferences } from '@agor-live/client';

/**
 * Canonical onboarding goal cards.
 *
 * Onboarding asks what the user wants done (outcome), not who they are (role).
 * Each goal is the single source of truth for its card copy, its recommended MCP
 * integrations, and the one bootstrap line that primes the first teammate
 * session. Goal `id`s are the stable values persisted to
 * `user.preferences.onboarding.goals` (order-preserving, max 2).
 */

export interface McpRecommendation {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** Set on the top recommendation of a rendered list, not stored per-entry. */
  featured?: boolean;
}

export interface OnboardingGoal {
  id: string;
  title: string;
  description: string;
  /** Recommended MCP integration ids, in priority order (see MCP_RECOMMENDATIONS). */
  mcpRecs: string[];
  /** One line telling the first teammate session what this user wants and how to open. */
  bootstrapLine: string;
}

/** MCP integrations referenced by goals + the skip fallback, keyed by id. */
export const MCP_RECOMMENDATIONS: Record<string, McpRecommendation> = {
  slack: {
    id: 'slack',
    name: 'Slack',
    emoji: '💬',
    description:
      'Get notified when sessions finish, send prompts from Slack, and schedule agents that report back to you.',
  },
  github: {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    description: 'Your AI opens PRs, reviews code, and syncs issues automatically.',
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    emoji: '🎯',
    description:
      "See what's in progress, what's blocked, and what shipped — without chasing updates.",
  },
  shortcut: {
    id: 'shortcut',
    name: 'Shortcut / Jira',
    emoji: '🎫',
    description:
      'Pull tickets into context and keep their status moving without leaving your session.',
  },
  calendar: {
    id: 'calendar',
    name: 'Calendar',
    emoji: '📅',
    description:
      'Your AI reads your schedule, preps for meetings, and turns discussions into action items.',
  },
  sentry: {
    id: 'sentry',
    name: 'Sentry',
    emoji: '🚨',
    description: 'Let your AI read error traces and fix bugs straight from the issue.',
  },
  datadog: {
    id: 'datadog',
    name: 'Datadog',
    emoji: '🐕',
    description: 'Query metrics, read alerts, and have your AI investigate anomalies for you.',
  },
  hubspot: {
    id: 'hubspot',
    name: 'HubSpot',
    emoji: '🟠',
    description: "Pull customer context into sessions — your AI knows who you're building for.",
  },
  figma: {
    id: 'figma',
    name: 'Figma',
    emoji: '🎨',
    description: 'Read design files and turn them into working UI without switching tabs.',
  },
  amplitude: {
    id: 'amplitude',
    name: 'Amplitude',
    emoji: '📈',
    description: 'Ask your AI what the data says without writing a single query.',
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    emoji: '📝',
    description: 'Write and update docs as your AI works.',
  },
};

/** Rec set shown when onboarding is skipped / no goal is picked. */
export const DEFAULT_MCP_REC_IDS = ['slack', 'github', 'linear', 'notion'];

/**
 * The six onboarding goal cards. Card copy is locked product copy — do not
 * rewrite. Selection order matters: first-picked = primary, second = secondary.
 *
 * Descriptions must only promise capabilities supported by today's connector
 * set; future inbox/news support is intentionally not advertised here.
 */
export const ONBOARDING_GOALS: OnboardingGoal[] = [
  {
    id: 'personal-teammate',
    title: 'Get a personal teammate',
    description: 'Keeps up with Slack so you don’t have to.',
    mcpRecs: ['slack'],
    bootstrapLine:
      'Desired outcome: a useful recurring brief from connected sources. A first win is a Slack digest based on the channels they care about.',
  },
  {
    id: 'status-updates',
    title: 'Never chase an update',
    description: 'Meeting notes and status, drafted for you.',
    mcpRecs: ['linear', 'shortcut', 'slack', 'calendar'],
    bootstrapLine:
      'Desired outcome: fewer status chases. A first win is a draft recap and action list for their current project or latest meeting.',
  },
  {
    id: 'ship-without-busywork',
    title: 'Ship without the busywork',
    description: 'PRs, bug triage, release notes — handled.',
    mcpRecs: ['github', 'sentry', 'datadog'],
    bootstrapLine:
      'Desired outcome: less shipping busywork. A first win is scanning the relevant repo for an actionable issue or pull request.',
  },
  {
    id: 'team-teammate',
    title: 'A teammate for the team',
    description: "Knows the whole team's Slack, docs, and boards.",
    mcpRecs: ['slack', 'hubspot', 'linear', 'datadog'],
    bootstrapLine:
      'Desired outcome: a shared teammate for repeated team work. A first win is identifying one repeated workflow to run from the team board.',
  },
  {
    id: 'hand-off-build',
    title: 'Hand off the build',
    description: 'A working app or dashboard, ready to use.',
    mcpRecs: ['github', 'figma'],
    bootstrapLine:
      'Desired outcome: a working build, not a spec. A first win is starting the requested prototype, internal tool, or dashboard live on the board.',
  },
  {
    id: 'dig-into-anything',
    title: 'Dig into anything',
    description: 'Ask a question, get real research back.',
    mcpRecs: ['amplitude', 'hubspot'],
    bootstrapLine:
      'Desired outcome: active research on demand. A first win is one evidence-backed finding about the competitor, market, or dataset they care about.',
  },
];

/** Max goals a user may select in onboarding. */
export const MAX_ONBOARDING_GOALS = 2;

export interface CompletedOnboardingPreferencesInput {
  boardId: string;
  branchId: string;
  path: 'teammate' | 'own-repo';
  goals?: string[];
}

/**
 * Merge completion into the freshest available preference snapshot. Goals are
 * deliberately materialized as [] when skipped instead of leaving an older
 * selection behind.
 */
export function buildCompletedOnboardingPreferences(
  latest: UserPreferences | undefined,
  result: CompletedOnboardingPreferencesInput
): UserPreferences {
  return {
    ...latest,
    mainBoardId: result.boardId || latest?.mainBoardId,
    onboarding: {
      ...latest?.onboarding,
      path: result.path,
      branchId: result.branchId,
      boardId: result.boardId,
      goals: result.goals ?? [],
    },
  };
}

export function findOnboardingGoal(id?: string | null): OnboardingGoal | undefined {
  return id ? ONBOARDING_GOALS.find((goal) => goal.id === id) : undefined;
}

function resolveRecs(ids: string[]): McpRecommendation[] {
  return ids.map((id) => MCP_RECOMMENDATIONS[id]).filter((rec): rec is McpRecommendation => !!rec);
}

/**
 * Build the MCP recommendations to show for the selected goals.
 *
 * - 0 goals: the generic default set.
 * - 1 goal: that goal's full rec list.
 * - 2 goals: first 2 recs from the primary goal, then first 2 from the
 *   secondary, deduped; if that leaves fewer than 4, refill from the primary's
 *   remaining recs first, then the secondary's, until 4 (or both are exhausted).
 *
 * The first returned rec is flagged `featured` as the top pick.
 */
export function mergeGoalMcpRecs(goalIds: string[]): McpRecommendation[] {
  const goals = goalIds
    .map((id) => findOnboardingGoal(id))
    .filter((goal): goal is OnboardingGoal => !!goal);

  let mergedIds: string[];
  if (goals.length === 0) {
    mergedIds = DEFAULT_MCP_REC_IDS;
  } else if (goals.length === 1) {
    mergedIds = goals[0].mcpRecs;
  } else {
    const [primary, secondary] = goals;
    const seen = new Set<string>();
    const ordered: string[] = [];
    const add = (id: string) => {
      if (ordered.length >= 4 || seen.has(id)) return;
      seen.add(id);
      ordered.push(id);
    };
    primary.mcpRecs.slice(0, 2).forEach(add);
    secondary.mcpRecs.slice(0, 2).forEach(add);
    primary.mcpRecs.slice(2).forEach(add);
    secondary.mcpRecs.slice(2).forEach(add);
    mergedIds = ordered;
  }

  return resolveRecs(mergedIds).map((rec, index) =>
    index === 0 ? { ...rec, featured: true } : rec
  );
}

/**
 * Build the goal-driven guidance lines for the first teammate session.
 *
 * - 0 goals: a single line telling the teammate to follow the user's lead.
 * - 1 goal: that goal's bootstrap line.
 * The returned lines describe outcomes and candidate wins. The shared prompt
 * owns the one canonical executable opening strategy, so these lines never
 * compete with it using goal-specific "ask" versus "act" commands.
 */
export function buildGoalBootstrapGuidance(goalIds: string[]): string[] {
  const goals = goalIds
    .map((id) => findOnboardingGoal(id))
    .filter((goal): goal is OnboardingGoal => !!goal);

  if (goals.length === 0) {
    return [
      'The user skipped picking a goal. Ask what they are working on right now and follow their lead — do not assume a goal.',
    ];
  }

  if (goals.length === 1) {
    return [goals[0].bootstrapLine];
  }

  const [primary, secondary] = goals;
  return [
    primary.bootstrapLine,
    secondary.bootstrapLine,
    `Treat "${primary.title}" as primary. Once its first win is delivered or clearly underway, proactively offer "${secondary.title}" too; do not ask which matters more because the user picked both.`,
  ];
}
