import type { UserPreferences } from '@agor-live/client';
import {
  BuildOutlined,
  FileTextOutlined,
  RocketOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { AntdIconProps } from '@ant-design/icons/lib/components/AntdIcon';

/**
 * Canonical onboarding goal cards.
 *
 * Onboarding asks what the user wants done (outcome), not who they are (role).
 * Each goal is the single source of truth for its card copy, its recommended
 * tools/connections, and the one bootstrap line that primes the first teammate
 * session. Goal `id`s are the stable values persisted to
 * `user.preferences.onboarding.goals` (order-preserving, max 2).
 */

export type IntegrationSetup =
  | { surface: 'marketplace'; catalogEntryName: string }
  | { surface: 'mcp-settings'; endpoint: string }
  | { surface: 'connected-repository' };

export interface OnboardingIntegrationRecommendation {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** The real Agor surface that can provide this capability today. */
  setup: IntegrationSetup;
  /** Set on the top recommendation of a rendered list, not stored per-entry. */
  featured?: boolean;
}

interface OnboardingGoalDefinition {
  id: string;
  title: string;
  description: string;
  /** antd icon rendered as the goal card's subtle accent tile (no category color). */
  icon: React.ComponentType<Partial<AntdIconProps>>;
  /** Recommended tool/connection ids, in priority order. */
  integrationRecs: readonly string[];
  /** One line telling the first teammate session what this user wants and how to open. */
  bootstrapLine: string;
}

/**
 * Tools and connections referenced by goals + the skip fallback, keyed by id.
 *
 * Keep every setup route explicit. Catalog entries must name a currently
 * curated catalog identity; custom MCP endpoints and Agor-native repository
 * access must never be described as Catalog installs.
 */
export const ONBOARDING_INTEGRATION_RECOMMENDATIONS: Record<
  string,
  OnboardingIntegrationRecommendation
> = {
  slack: {
    id: 'slack',
    name: 'Slack',
    emoji: '💬',
    description:
      'Get notified when sessions finish, send prompts from Slack, and schedule agents that report back to you.',
    setup: { surface: 'mcp-settings', endpoint: 'https://mcp.slack.com/mcp' },
  },
  github: {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    description: 'Your AI opens PRs, reviews code, and syncs issues automatically.',
    setup: { surface: 'connected-repository' },
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    emoji: '🎯',
    description:
      "See what's in progress, what's blocked, and what shipped, without chasing updates.",
    setup: { surface: 'marketplace', catalogEntryName: 'app.linear/linear' },
  },
  atlassian: {
    id: 'atlassian',
    name: 'Atlassian',
    emoji: '🎫',
    description:
      'Pull Jira work into context and keep its status moving without leaving your session.',
    setup: {
      surface: 'marketplace',
      catalogEntryName: 'com.atlassian/atlassian-mcp-server',
    },
  },
  sentry: {
    id: 'sentry',
    name: 'Sentry',
    emoji: '🚨',
    description: 'Let your AI read error traces and fix bugs straight from the issue.',
    setup: { surface: 'marketplace', catalogEntryName: 'io.sentry/mcp' },
  },
  datadog: {
    id: 'datadog',
    name: 'Datadog',
    emoji: '🐕',
    description: 'Query metrics, read alerts, and have your AI investigate anomalies for you.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.datadoghq/mcp' },
  },
  figma: {
    id: 'figma',
    name: 'Figma',
    emoji: '🎨',
    description: 'Read design files and turn them into working UI without switching tabs.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.figma.mcp/mcp' },
  },
  amplitude: {
    id: 'amplitude',
    name: 'Amplitude',
    emoji: '📈',
    description: 'Ask your AI what the data says without writing a single query.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.amplitude/mcp-server' },
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    emoji: '📝',
    description: 'Write and update docs as your AI works.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.notion/mcp' },
  },
  firecrawl: {
    id: 'firecrawl',
    name: 'Firecrawl',
    emoji: '🔥',
    description: 'Gather current web sources for evidence-backed research.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.firecrawl/mcp' },
  },
};

/** Rec set shown when onboarding is skipped / no goal is picked. */
export const DEFAULT_INTEGRATION_REC_IDS = ['slack', 'github', 'linear', 'notion'];

/**
 * The six onboarding goal cards. Card copy is locked product copy — do not
 * rewrite. Selection order matters: first-picked = primary, second = secondary.
 *
 * Descriptions must only promise capabilities supported by today's connector
 * set; future inbox/news support is intentionally not advertised here.
 */
export const ONBOARDING_GOALS = [
  {
    id: 'personal-teammate',
    title: 'Get a personal teammate',
    description: 'Keeps up with Slack so you don’t have to.',
    icon: UserOutlined,
    integrationRecs: ['slack'],
    bootstrapLine:
      'Desired outcome: a useful recurring brief from connected sources. A first win is a Slack digest based on the channels they care about.',
  },
  {
    id: 'status-updates',
    title: 'Never chase an update',
    description: 'Meeting notes and status, drafted for you.',
    icon: FileTextOutlined,
    integrationRecs: ['linear', 'atlassian', 'notion', 'slack'],
    bootstrapLine:
      'Desired outcome: fewer status chases. A first win is a draft recap and action list for their current project or latest meeting.',
  },
  {
    id: 'ship-without-busywork',
    title: 'Ship without the busywork',
    description: 'PRs, bug triage, and release notes, all handled.',
    icon: RocketOutlined,
    integrationRecs: ['github', 'sentry', 'datadog'],
    bootstrapLine:
      'Desired outcome: less shipping busywork. A first win is scanning the relevant repo for an actionable issue or pull request.',
  },
  {
    id: 'team-teammate',
    title: 'A teammate for the team',
    description: "Knows the whole team's Slack, docs, and boards.",
    icon: TeamOutlined,
    integrationRecs: ['slack', 'notion', 'linear', 'datadog'],
    bootstrapLine:
      'Desired outcome: a shared teammate for repeated team work. A first win is identifying one repeated workflow to run from the team board.',
  },
  {
    id: 'hand-off-build',
    title: 'Build me an app',
    description: 'A working app or dashboard on a live test env.',
    icon: BuildOutlined,
    integrationRecs: ['github', 'figma'],
    bootstrapLine:
      'Desired outcome: a working build, not a spec. A first win is starting the requested prototype, internal tool, or dashboard live on the board.',
  },
  {
    id: 'dig-into-anything',
    title: 'Dig into anything',
    description: 'Ask a question, get real research back.',
    icon: SearchOutlined,
    integrationRecs: ['amplitude', 'firecrawl'],
    bootstrapLine:
      'Desired outcome: active research on demand. A first win is one evidence-backed finding about the competitor, market, or dataset they care about.',
  },
] as const satisfies readonly OnboardingGoalDefinition[];

/** Stable persisted identifiers derived from the canonical goal definitions. */
export type OnboardingGoalId = (typeof ONBOARDING_GOALS)[number]['id'];
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

/** Max goals a user may select in onboarding. */
export const MAX_ONBOARDING_GOALS = 2;

export interface CompletedOnboardingPreferencesInput {
  boardId: string;
  branchId: string;
  path: 'teammate' | 'own-repo';
  goals?: string[];
  teammateName?: string;
  teammateEmoji?: string;
  templateId?: string | null;
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
  const retainedOnboarding = { ...(latest?.onboarding ?? {}) };
  delete retainedOnboarding.deferredAt;
  delete retainedOnboarding.teammateDisplayName;
  delete retainedOnboarding.teammateEmoji;
  delete retainedOnboarding.teammateTemplateId;
  return {
    ...latest,
    mainBoardId: result.boardId || latest?.mainBoardId,
    onboarding: {
      ...retainedOnboarding,
      path: result.path,
      branchId: result.branchId,
      boardId: result.boardId,
      goals: result.goals ?? [],
      ...(result.teammateName ? { teammateDisplayName: result.teammateName } : {}),
      ...(result.teammateName && result.teammateEmoji
        ? { teammateEmoji: result.teammateEmoji }
        : {}),
      ...(result.teammateName && result.templateId
        ? { teammateTemplateId: result.templateId }
        : {}),
    },
  };
}

export function findOnboardingGoal(id?: string | null): OnboardingGoal | undefined {
  return id ? ONBOARDING_GOALS.find((goal) => goal.id === id) : undefined;
}

function resolveRecs(ids: readonly string[]): OnboardingIntegrationRecommendation[] {
  return ids
    .map((id) => ONBOARDING_INTEGRATION_RECOMMENDATIONS[id])
    .filter((rec): rec is OnboardingIntegrationRecommendation => !!rec);
}

/**
 * Build the routed tool/connection recommendations for the selected goals.
 *
 * - 0 goals: the generic default set.
 * - 1 goal: that goal's full rec list.
 * - 2 goals: first 2 recs from the primary goal, then first 2 from the
 *   secondary, deduped; if that leaves fewer than 4, refill from the primary's
 *   remaining recs first, then the secondary's, until 4 (or both are exhausted).
 *
 * The first returned rec is flagged `featured` as the top pick.
 */
export function mergeGoalIntegrationRecs(goalIds: string[]): OnboardingIntegrationRecommendation[] {
  const goals = goalIds
    .map((id) => findOnboardingGoal(id))
    .filter((goal): goal is OnboardingGoal => !!goal);

  let mergedIds: string[];
  if (goals.length === 0) {
    mergedIds = DEFAULT_INTEGRATION_REC_IDS;
  } else if (goals.length === 1) {
    mergedIds = [...goals[0].integrationRecs];
  } else {
    const [primary, secondary] = goals;
    const seen = new Set<string>();
    const ordered: string[] = [];
    const add = (id: string) => {
      if (ordered.length >= 4 || seen.has(id)) return;
      seen.add(id);
      ordered.push(id);
    };
    primary.integrationRecs.slice(0, 2).forEach(add);
    secondary.integrationRecs.slice(0, 2).forEach(add);
    primary.integrationRecs.slice(2).forEach(add);
    secondary.integrationRecs.slice(2).forEach(add);
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
      'The user skipped picking a goal. Ask what they are working on right now and follow their lead. Do not assume a goal.',
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
