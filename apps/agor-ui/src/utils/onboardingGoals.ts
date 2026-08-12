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
 * Known gap: "Get my own personal teammate" promises reading inbox/news, but no
 * email/news MCP connector exists yet — only the Slack part is real today.
 */
export const ONBOARDING_GOALS: OnboardingGoal[] = [
  {
    id: 'personal-teammate',
    title: 'Get my own personal teammate',
    description: "Reads your inbox, Slack, and news so you don't have to.",
    mcpRecs: ['slack'],
    bootstrapLine:
      "Wants a daily brief across scattered sources. Ask what's overwhelming them most (Slack, industry news) and propose a recurring digest as the first win.",
  },
  {
    id: 'status-updates',
    title: 'Never chase a status update again',
    description: 'Meeting notes, action items, and project updates — drafted for you.',
    mcpRecs: ['linear', 'shortcut', 'slack', 'calendar'],
    bootstrapLine:
      'Drowning in status-chasing. Ask about their current project or last meeting, offer to draft the recap + action items as the first win.',
  },
  {
    id: 'ship-without-busywork',
    title: 'Ship without the busywork',
    description: 'PRs, bug triage, release notes — handled.',
    mcpRecs: ['github', 'sentry', 'datadog'],
    bootstrapLine:
      'Wants execution handled. Ask which repo, offer to scan open issues/PRs for a quick win.',
  },
  {
    id: 'team-teammate',
    title: 'Give my team an AI teammate',
    description: "One helper who knows everyone's Slack, docs, and boards — not just yours.",
    mcpRecs: ['slack', 'hubspot', 'linear', 'datadog'],
    bootstrapLine:
      'Wants a shared teammate for the team. Ask what the team repeats manually across people, propose seeding a shared teammate onto the team board.',
  },
  {
    id: 'hand-off-build',
    title: 'Hand off the build',
    description: 'A working app, dashboard, or prototype — live on your board, ready to use.',
    mcpRecs: ['github', 'figma'],
    bootstrapLine:
      'Wants a working thing built, not a spec. Ask what they want built (a prototype, an internal tool, a dashboard) and start building something live on the board as the first win.',
  },
  {
    id: 'dig-into-anything',
    title: 'Dig into anything',
    description: 'Ask a question, get real research back — competitors, markets, data.',
    mcpRecs: ['amplitude', 'hubspot'],
    bootstrapLine:
      "Wants active research/analysis on demand, not a scheduled digest (that's goal 1's job). Ask what they want dug into (a competitor, a market, a dataset) and deliver one real finding as the first win, not a to-do list.",
  },
];

/** Max goals a user may select in onboarding. */
export const MAX_ONBOARDING_GOALS = 2;

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
 * - 2 goals: both bootstrap lines plus a bridging line — open with a concrete
 *   action on the primary (first-picked) goal, then surface the secondary once
 *   the first win is underway, without asking which matters more.
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
    `Treat "${primary.title}" as the primary goal: open your first message with a concrete action on it, not a question. Once that first win is delivered or clearly underway, proactively offer to also help with "${secondary.title}". Do not ask which matters more — the user picked both.`,
  ];
}
