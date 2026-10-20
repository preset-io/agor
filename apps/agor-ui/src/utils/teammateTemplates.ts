import type { MCPCatalogCategory, MCPCatalogEntry } from '@agor/core/types';
import { TEAMMATE_FRAMEWORK_DEFAULT_BRANCH, TEAMMATE_FRAMEWORK_REPO_URL } from '@agor-live/client';
import {
  AimOutlined,
  BuildOutlined,
  CodeOutlined,
  FundOutlined,
  PlusOutlined,
  ProjectOutlined,
  RadarChartOutlined,
  ReconciliationOutlined,
  SafetyOutlined,
  SearchOutlined,
  SolutionOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { AntdIconProps } from '@ant-design/icons/lib/components/AntdIcon';
import { AVATAR_PALETTE } from './avatarPalette';

/**
 * Canonical teammate starter templates.
 *
 * A template either pre-points a new teammate at a ready-made source branch in
 * the `preset-io/agor-teammate` repo, or is prompt-only: no branch (the
 * framework default, like the blank starter) plus a `remit` line for the first
 * session prompt. Card copy is product copy owned by design. This module is the
 * single source of truth for the templates and the pure helpers that drive the
 * TeammateGallery. Keep it dependency-light and side-effect-free.
 *
 * The `sourceBranch` values are a contract with `preset-io/agor-teammate`. Use
 * the exact names below; add prompt-only templates rather than new branches.
 */

/** Category buckets a template can belong to. The blank starter has none. */
export type TeammateCategoryId = 'grow' | 'build' | 'operate';

export interface TeammateCategory {
  id: TeammateCategoryId;
  label: string;
  /**
   * Icon accent color for the category, sourced from the shared avatar palette
   * (see AVATAR_COLORS) — never a bespoke hue. Cards tint their icon (and a soft
   * low-opacity tile behind it) with this so a category reads at a glance.
   */
  color: string;
}

export interface TeammateTemplate {
  id: string;
  title: string;
  description: string;
  icon: React.ComponentType<Partial<AntdIconProps>>;
  /** Category bucket; omitted for the blank starter (it has no category). */
  category?: TeammateCategoryId;
  /** Default avatar emoji applied on selection; empty for the blank starter. */
  emoji: string;
  /** Branch in the framework repo the teammate is cut from; omitted = framework default. */
  sourceBranch?: string;
  /** Remote that owns sourceBranch when it differs from the teammate's destination repo. */
  sourceRemoteUrl?: string;
  /** Prompt-only templates: what the teammate is for, fed into the first-session prompt. */
  remit?: string;
  /** Catalog entry names onboarding's tools wall lists first, in this order. */
  preferredTools?: readonly string[];
  /** Catalog categories listed next, in this order. The rest keep the curated order. */
  preferredToolCategories?: readonly MCPCatalogCategory[];
}

const BUILT_IN_TEMPLATE_SOURCE = { sourceRemoteUrl: TEAMMATE_FRAMEWORK_REPO_URL } as const;

/**
 * The three category buckets, in display order. Single source of truth for the
 * filter chips, the per-card icon accent, and the tests. Each `color` is a
 * specific entry of the shared avatar palette (AVATAR_PALETTE) — reused, never
 * invented — so categories read in the same muted family as user avatars.
 */
export const TEMPLATE_CATEGORIES = [
  { id: 'grow', label: 'Grow', color: AVATAR_PALETTE[2] }, // sage
  { id: 'build', label: 'Build', color: AVATAR_PALETTE[6] }, // dusty blue
  { id: 'operate', label: 'Operate', color: AVATAR_PALETTE[5] }, // warm sand
] as const satisfies readonly TeammateCategory[];

/** The full category record (id, label, color) for an id, or undefined. */
export function getCategory(id?: TeammateCategoryId): TeammateCategory | undefined {
  return id ? TEMPLATE_CATEGORIES.find((category) => category.id === id) : undefined;
}

/** Accent color for a category id, from the shared avatar palette. */
export function getCategoryColor(id?: TeammateCategoryId): string | undefined {
  return getCategory(id)?.color;
}

/** The blank starter's id — selecting it means "no template" (repo default branch). */
export const BLANK_TEMPLATE_ID = 'blank';

export const TEAMMATE_TEMPLATES = [
  {
    id: 'personal-assistant',
    title: 'Personal assistant',
    description: "Keeps up with Slack and your docs so you don't have to.",
    icon: UserOutlined,
    category: 'operate',
    emoji: '🧑‍💼',
    remit:
      'Desired outcome: a useful recurring brief from Slack and connected docs. A first win is a digest of the channels and docs they care about.',
    preferredTools: [
      'com.googleapis.gmailmcp/mcp',
      'com.googleapis.calendarmcp/mcp',
      'ai.granola/mcp',
      'com.notion/mcp',
      'app.fellow/mcp',
      'com.atlassian/atlassian-mcp-server',
      'com.asana/mcp',
      'com.zapier/mcp',
    ],
    preferredToolCategories: ['productivity', 'messaging', 'search'],
  },
  {
    id: 'researcher',
    title: 'Researcher',
    description: 'Ask a question, get real research back.',
    icon: SearchOutlined,
    category: 'grow',
    emoji: '🔎',
    remit:
      'Desired outcome: active research on demand. A first win is one evidence-backed finding about the competitor, market, or dataset they care about.',
    preferredTools: ['ai.jina/mcp'],
    preferredToolCategories: ['search', 'data-storage', 'productivity'],
  },
  {
    id: 'engineering-assistant',
    title: 'Engineering assistant',
    description: 'Handles PRs, bug triage and release notes.',
    icon: CodeOutlined,
    category: 'build',
    emoji: '🧰',
    remit:
      'Desired outcome: less busywork around PRs, bug triage and release notes. A first win is scanning the relevant repo for an actionable issue or pull request.',
    preferredToolCategories: ['dev-tools', 'observability'],
  },
  {
    id: 'builder',
    title: 'Builder',
    description: 'Turns your idea into a working app or dashboard.',
    icon: BuildOutlined,
    category: 'build',
    emoji: '🛠️',
    sourceBranch: 'template/builder',
    ...BUILT_IN_TEMPLATE_SOURCE,
    preferredTools: ['io.github.github/github-mcp-server', 'com.supabase/mcp', 'com.netlify/mcp'],
    preferredToolCategories: ['dev-tools', 'data-storage'],
  },
  {
    id: 'product-manager',
    title: 'Product manager',
    description: 'Turns feedback into a clear, prioritized backlog.',
    icon: ProjectOutlined,
    category: 'build',
    emoji: '🧭',
    sourceBranch: 'template/product-manager',
    ...BUILT_IN_TEMPLATE_SOURCE,
    preferredTools: ['app.linear/linear', 'com.atlassian/atlassian-mcp-server', 'com.notion/mcp'],
    preferredToolCategories: ['productivity', 'observability'],
  },
  {
    id: 'chief-of-staff',
    title: 'Chief of staff',
    description: 'Triages the noise, preps meetings, closes the loop.',
    icon: SolutionOutlined,
    category: 'operate',
    emoji: '🗂️',
    sourceBranch: 'template/chief-of-staff',
    ...BUILT_IN_TEMPLATE_SOURCE,
    preferredTools: [
      'ai.granola/mcp',
      'com.notion/mcp',
      'app.fellow/mcp',
      'com.asana/mcp',
      'ai.fireflies/fireflies',
    ],
    preferredToolCategories: ['productivity', 'messaging'],
  },
  {
    id: 'competitive-analyst',
    title: 'Competitive analyst',
    description: "Tracks rivals' pricing, launches and moves for you.",
    icon: RadarChartOutlined,
    category: 'grow',
    emoji: '🔭',
    sourceBranch: 'template/competitive-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
    preferredToolCategories: ['search', 'productivity'],
  },
  {
    id: 'financial-analyst',
    title: 'Financial analyst',
    description: "Reads the numbers and flags what doesn't add up.",
    icon: FundOutlined,
    category: 'operate',
    emoji: '🧮',
    sourceBranch: 'template/financial-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
    preferredTools: ['com.stripe/mcp', 'com.paypal.mcp/mcp', 'io.preset/mcp-gateway'],
    preferredToolCategories: ['data-storage', 'productivity'],
  },
  {
    id: 'deal-desk',
    title: 'Deal desk analyst',
    description: 'Keeps deals clean and renewals on time.',
    icon: ReconciliationOutlined,
    category: 'grow',
    emoji: '📐',
    sourceBranch: 'template/deal-desk-revops-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
    preferredTools: ['com.attio/mcp', 'com.stripe/mcp', 'com.hubspot/mcp', 'com.salesforce/mcp'],
    preferredToolCategories: ['productivity', 'messaging'],
  },
  {
    id: 'sales-outbound',
    title: 'Outbound analyst',
    description: 'Builds target lists and drafts the outreach.',
    icon: AimOutlined,
    category: 'grow',
    emoji: '🎯',
    sourceBranch: 'template/sales-outbound-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
    preferredTools: [
      'com.attio/mcp',
      'com.apify/apify-mcp-server',
      'com.hubspot/mcp',
      'com.salesforce/mcp',
    ],
    preferredToolCategories: ['messaging', 'search', 'productivity'],
  },
  {
    id: 'legal-analyst',
    title: 'Legal analyst',
    description: 'Reads the redline and flags the risk.',
    icon: SafetyOutlined,
    category: 'operate',
    emoji: '⚖️',
    sourceBranch: 'template/legal-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
    preferredToolCategories: ['productivity', 'search'],
  },
] as const satisfies readonly TeammateTemplate[];

/** Stable source-template identifiers derived from the canonical definitions. */
export type TeammateTemplateId = (typeof TEAMMATE_TEMPLATES)[number]['id'];

/**
 * The blank starter card, shown first. Kept separate from TEAMMATE_TEMPLATES so
 * it is never categorized. Its `sourceBranch` is the framework repo default; the
 * wiring resolves it to the repo's own default branch (the public template's for
 * a github.com private fork).
 */
export const BLANK_TEMPLATE = {
  id: BLANK_TEMPLATE_ID,
  title: 'Start from scratch',
  description: 'A blank teammate you shape as you chat.',
  icon: PlusOutlined,
  emoji: '✨',
  sourceBranch: TEAMMATE_FRAMEWORK_DEFAULT_BRANCH,
} as const satisfies TeammateTemplate;

export type TeammateGalleryCardId = TeammateTemplateId | typeof BLANK_TEMPLATE_ID;

/** Every card shown in the gallery: the blank starter, then all templates. */
export const TEAMMATE_GALLERY_CARDS = [BLANK_TEMPLATE, ...TEAMMATE_TEMPLATES] as const;
export type TeammateGalleryCard = (typeof TEAMMATE_GALLERY_CARDS)[number];

export function getTeammateTemplate(id?: string | null): TeammateGalleryCard | undefined {
  return id ? TEAMMATE_GALLERY_CARDS.find((template) => template.id === id) : undefined;
}

/**
 * Source branch a teammate should be cut from for the given template.
 *
 * Branch templates force their contract branch; prompt-only templates, the
 * blank starter, and no selection return undefined so branch creation falls back
 * to the framework repo's own default branch (the public template's for a
 * github.com private fork).
 */
export function resolveTemplateSourceBranch(id?: string | null): string | undefined {
  if (!id || id === BLANK_TEMPLATE_ID) return undefined;
  const template = getTeammateTemplate(id);
  if (!template) {
    throw new Error(`Unknown teammate template id: ${id}`);
  }
  return 'sourceBranch' in template ? template.sourceBranch : undefined;
}

/** Remote that owns the selected template ref; blank/no selection defers to createTeammateBranch. */
export function resolveTemplateSourceRemoteUrl(id?: string | null): string | undefined {
  if (!id || id === BLANK_TEMPLATE_ID) return undefined;
  const template = getTeammateTemplate(id);
  if (!template) {
    throw new Error(`Unknown teammate template id: ${id}`);
  }
  return 'sourceRemoteUrl' in template ? template.sourceRemoteUrl : undefined;
}

/**
 * The template a teammate was cut from, matched by its `sourceBranch`.
 *
 * Inverse of `resolveTemplateSourceBranch`: given the branch a teammate now
 * lives on, recover the template (and its persona) it came from. A blank or
 * `main` source branch is the framework repo default, not a real template, so
 * it resolves to undefined. Pure and side-effect-free.
 */
export function getTemplateBySourceBranch(
  sourceBranch?: string | null
): TeammateTemplate | undefined {
  const branch = sourceBranch?.trim();
  if (!branch || branch === BLANK_TEMPLATE.sourceBranch) return undefined;
  return TEAMMATE_TEMPLATES.find(
    (template) => 'sourceBranch' in template && template.sourceBranch === branch
  );
}

/**
 * Recover a template only when a manual teammate was cut from the detected
 * framework repository. Source-branch names are not globally meaningful: an
 * unrelated repository may legitimately have the same branch name.
 */
export function getTemplateForFrameworkSource({
  sourceBranch,
  selectedRepoId,
  frameworkRepoId,
}: {
  sourceBranch?: string | null;
  selectedRepoId?: string | null;
  frameworkRepoId?: string | null;
}): TeammateTemplate | undefined {
  if (!selectedRepoId || selectedRepoId !== frameworkRepoId) return undefined;
  return getTemplateBySourceBranch(sourceBranch);
}

/**
 * Onboarding's tools wall order for a template: its `preferredTools`, then its
 * `preferredToolCategories`, then everything else. The sort is stable, so ties
 * keep the incoming (curated) order. It only reorders: nothing is dropped, and
 * no template (or the blank starter) leaves the order unchanged.
 */
export function sortToolsForTemplate<T extends Pick<MCPCatalogEntry, 'name' | 'category'>>(
  entries: readonly T[],
  template?: TeammateTemplate
): T[] {
  const tools = template?.preferredTools ?? [];
  const categories = template?.preferredToolCategories ?? [];
  const rank = (entry: T) => {
    const tool = tools.indexOf(entry.name);
    if (tool >= 0) return tool;
    const category = categories.indexOf(entry.category);
    return tools.length + (category >= 0 ? category : categories.length);
  };
  return [...entries].sort((a, b) => rank(a) - rank(b));
}

/** The gallery's active filter: everything, or a single category. */
export type GalleryFilter = 'all' | TeammateCategoryId;

/**
 * Cards to render for the active filter: `all` is every template in display
 * order after the blank starter; a category shows only its templates.
 */
export function galleryCardsForFilter(filter: GalleryFilter): readonly TeammateGalleryCard[] {
  if (filter !== 'all') {
    return TEAMMATE_TEMPLATES.filter((template) => template.category === filter);
  }
  return TEAMMATE_GALLERY_CARDS;
}
