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

/**
 * How the tools step lets a user set this up, without re-deriving it from `setup`:
 * - `oauth`  one-click catalog OAuth (most curated servers).
 * - `none`   catalog connect with no sign-in (keyless endpoints).
 * - `ask`    handed to the first-session teammate to arrange (Slack, GitHub).
 */
export type IntegrationConnectMode = 'oauth' | 'none' | 'ask';

export interface OnboardingIntegrationRecommendation {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** The real Agor surface that can provide this capability today. */
  setup: IntegrationSetup;
  /** Discriminates Connect vs Ask-the-teammate in the tools step. */
  connectMode: IntegrationConnectMode;
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
 * Keep every setup route explicit. Marketplace entries must name a currently
 * curated catalog identity; custom MCP endpoints and Agor-native repository
 * access must never be described as Marketplace installs.
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
    connectMode: 'ask',
  },
  github: {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    description: 'Your AI opens PRs, reviews code, and syncs issues automatically.',
    setup: { surface: 'connected-repository' },
    connectMode: 'ask',
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    emoji: '🎯',
    description:
      "See what's in progress, what's blocked, and what shipped, without chasing updates.",
    setup: { surface: 'marketplace', catalogEntryName: 'app.linear/linear' },
    connectMode: 'oauth',
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
    connectMode: 'oauth',
  },
  sentry: {
    id: 'sentry',
    name: 'Sentry',
    emoji: '🚨',
    description: 'Let your AI read error traces and fix bugs straight from the issue.',
    setup: { surface: 'marketplace', catalogEntryName: 'io.sentry/mcp' },
    connectMode: 'oauth',
  },
  figma: {
    id: 'figma',
    name: 'Figma',
    emoji: '🎨',
    description: 'Read design files and turn them into working UI without switching tabs.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.figma.mcp/mcp' },
    connectMode: 'oauth',
  },
  amplitude: {
    id: 'amplitude',
    name: 'Amplitude',
    emoji: '📈',
    description: 'Ask your AI what the data says without writing a single query.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.amplitude/mcp-server' },
    connectMode: 'oauth',
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    emoji: '📝',
    description: 'Write and update docs as your AI works.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.notion/mcp' },
    connectMode: 'oauth',
  },
  firecrawl: {
    id: 'firecrawl',
    name: 'Firecrawl',
    emoji: '🔥',
    description: 'Gather current web sources for evidence-backed research.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.firecrawl/mcp' },
    connectMode: 'none',
  },
  asana: {
    id: 'asana',
    name: 'Asana',
    emoji: '✅',
    description: 'Keep Asana tasks and projects in sync without manual status updates.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.asana/mcp' },
    connectMode: 'oauth',
  },
  miro: {
    id: 'miro',
    name: 'Miro',
    emoji: '🗺️',
    description: 'Read the board a plan was sketched on and draw the revised diagram back onto it.',
    setup: { surface: 'marketplace', catalogEntryName: 'io.github.miroapp/mcp-server' },
    connectMode: 'oauth',
  },
  gitlab: {
    id: 'gitlab',
    name: 'GitLab',
    emoji: '🦊',
    description: 'Drive merge requests and inspect failing pipelines from your session.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.gitlab/mcp' },
    connectMode: 'oauth',
  },
  semgrep: {
    id: 'semgrep',
    name: 'Semgrep',
    emoji: '🛡️',
    description: 'Run static analysis on your changes and get findings your AI can act on.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.semgrep/mcp' },
    connectMode: 'oauth',
  },
  supabase: {
    id: 'supabase',
    name: 'Supabase',
    emoji: '🗄️',
    description: 'Let your AI read your schema and run queries against your real database.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.supabase/mcp' },
    connectMode: 'oauth',
  },
  context7: {
    id: 'context7',
    name: 'Context7',
    emoji: '📚',
    description: 'Pull version-correct library docs so your AI stops inventing old APIs.',
    setup: { surface: 'marketplace', catalogEntryName: 'com.context7/mcp' },
    connectMode: 'none',
  },
  exa: {
    id: 'exa',
    name: 'Exa',
    emoji: '🔎',
    description: 'Give your AI semantic web search with full page content, not just links.',
    setup: { surface: 'marketplace', catalogEntryName: 'ai.exa/exa' },
    connectMode: 'none',
  },
  tavily: {
    id: 'tavily',
    name: 'Tavily',
    emoji: '🌐',
    description: 'Search the live web and pull the page text back in one step.',
    setup: { surface: 'marketplace', catalogEntryName: 'io.github.tavily-ai/tavily-mcp' },
    connectMode: 'oauth',
  },
};

/** How many Connect (non-`ask`) recommendations the tools step surfaces at once. */
export const CONNECT_KIT_SIZE = 4;

/**
 * Rec set shown when onboarding is skipped / no goal is picked. No goal bias:
 * generic popular Connect tools plus the two Ask-the-teammate extras.
 */
export const DEFAULT_INTEGRATION_REC_IDS = ['linear', 'notion', 'firecrawl', 'slack', 'github'];

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
    integrationRecs: ['notion', 'linear', 'firecrawl', 'slack'],
    bootstrapLine:
      'Desired outcome: a useful recurring brief from connected sources. A first win is a Slack digest based on the channels they care about.',
  },
  {
    id: 'status-updates',
    title: 'Never chase an update',
    description: 'Meeting notes and status, drafted for you.',
    icon: FileTextOutlined,
    integrationRecs: ['linear', 'notion', 'atlassian', 'asana', 'slack'],
    bootstrapLine:
      'Desired outcome: fewer status chases. A first win is a draft recap and action list for their current project or latest meeting.',
  },
  {
    id: 'ship-without-busywork',
    title: 'Ship without the busywork',
    description: 'PRs, bug triage, and release notes, all handled.',
    icon: RocketOutlined,
    integrationRecs: ['sentry', 'gitlab', 'linear', 'semgrep', 'github'],
    bootstrapLine:
      'Desired outcome: less shipping busywork. A first win is scanning the relevant repo for an actionable issue or pull request.',
  },
  {
    id: 'team-teammate',
    title: 'A teammate for the team',
    description: "Knows the whole team's Slack, docs, and boards.",
    icon: TeamOutlined,
    integrationRecs: ['notion', 'linear', 'atlassian', 'miro', 'slack'],
    bootstrapLine:
      'Desired outcome: a shared teammate for repeated team work. A first win is identifying one repeated workflow to run from the team board.',
  },
  {
    id: 'hand-off-build',
    title: 'Build me an app',
    description: 'A working app or dashboard on a live test env.',
    icon: BuildOutlined,
    integrationRecs: ['gitlab', 'supabase', 'figma', 'context7', 'github'],
    bootstrapLine:
      'Desired outcome: a working build, not a spec. A first win is starting the requested prototype, internal tool, or dashboard live on the board.',
  },
  {
    id: 'dig-into-anything',
    title: 'Dig into anything',
    description: 'Ask a question, get real research back.',
    icon: SearchOutlined,
    integrationRecs: ['exa', 'firecrawl', 'tavily', 'amplitude'],
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

const isAskRec = (rec: OnboardingIntegrationRecommendation) => rec.connectMode === 'ask';

/**
 * Build the routed tool/connection recommendations for the selected goals.
 *
 * The returned list is Connect items first (capped at {@link CONNECT_KIT_SIZE}),
 * then the Ask-the-teammate extras (Slack/GitHub) — which are never counted
 * against the Connect cap. The first Connect item is flagged `featured`.
 *
 * Connect-item selection:
 * - 0 goals: the generic default set.
 * - 1 goal: that goal's Connect items.
 * - 2 goals: first 2 Connect items from the primary, then first 2 from the
 *   secondary, deduped; if that leaves fewer than the cap, refill from the
 *   primary's remaining Connect items first, then the secondary's.
 *
 * Ask extras are the union of the goals' Ask items, order-preserving and deduped.
 */
export function mergeGoalIntegrationRecs(goalIds: string[]): OnboardingIntegrationRecommendation[] {
  const goals = goalIds
    .map((id) => findOnboardingGoal(id))
    .filter((goal): goal is OnboardingGoal => !!goal);

  const sources = (
    goals.length === 0 ? [DEFAULT_INTEGRATION_REC_IDS] : goals.map((goal) => goal.integrationRecs)
  ).map((ids) => {
    const recs = resolveRecs(ids);
    return { connect: recs.filter((rec) => !isAskRec(rec)), ask: recs.filter(isAskRec) };
  });

  const seen = new Set<string>();
  const connect: OnboardingIntegrationRecommendation[] = [];
  const addConnect = (rec: OnboardingIntegrationRecommendation) => {
    if (connect.length >= CONNECT_KIT_SIZE || seen.has(rec.id)) return;
    seen.add(rec.id);
    connect.push(rec);
  };
  if (sources.length <= 1) {
    sources[0]?.connect.forEach(addConnect);
  } else {
    const [primary, secondary] = sources;
    primary.connect.slice(0, 2).forEach(addConnect);
    secondary.connect.slice(0, 2).forEach(addConnect);
    primary.connect.slice(2).forEach(addConnect);
    secondary.connect.slice(2).forEach(addConnect);
  }

  const askSeen = new Set<string>();
  const ask: OnboardingIntegrationRecommendation[] = [];
  for (const source of sources) {
    for (const rec of source.ask) {
      if (askSeen.has(rec.id)) continue;
      askSeen.add(rec.id);
      ask.push(rec);
    }
  }

  return [...connect, ...ask].map((rec, index) => (index === 0 ? { ...rec, featured: true } : rec));
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
