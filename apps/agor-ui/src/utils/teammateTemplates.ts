import { TEAMMATE_FRAMEWORK_DEFAULT_BRANCH, TEAMMATE_FRAMEWORK_REPO_URL } from '@agor-live/client';
import {
  AimOutlined,
  BuildOutlined,
  FundOutlined,
  PlusOutlined,
  ProjectOutlined,
  RadarChartOutlined,
  ReconciliationOutlined,
  SafetyOutlined,
  SolutionOutlined,
} from '@ant-design/icons';
import type { AntdIconProps } from '@ant-design/icons/lib/components/AntdIcon';
import { AVATAR_PALETTE } from './avatarPalette';

/**
 * Canonical teammate starter templates.
 *
 * A template pre-points a new teammate at a ready-made source branch in the
 * `preset-io/agor-teammate` repo. Card copy is locked product copy — do not
 * rewrite. This module is the single source of truth for the templates and
 * the pure helpers that drive the TeammateGallery. Keep it dependency-light and side-effect-free.
 *
 * The `sourceBranch` values are a contract with a parallel workstream creating
 * matching branches in `preset-io/agor-teammate`. Use the exact names below.
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
  /** Branch in the framework repo the teammate is cut from. */
  sourceBranch: string;
  /** Remote that owns sourceBranch when it differs from the teammate's destination repo. */
  sourceRemoteUrl?: string;
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
    id: 'competitive-analyst',
    title: 'Competitive Analyst',
    description:
      "Tracks every rival's pricing, launches, and moves, then tells you what it means for the next deal.",
    icon: RadarChartOutlined,
    category: 'grow',
    emoji: '🔭',
    sourceBranch: 'template/competitive-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
  },
  {
    id: 'product-manager',
    title: 'Product Manager',
    description:
      'Turns scattered feedback into a clean, prioritized backlog and keeps everyone in the loop.',
    icon: ProjectOutlined,
    category: 'build',
    emoji: '🧭',
    sourceBranch: 'template/product-manager',
    ...BUILT_IN_TEMPLATE_SOURCE,
  },
  {
    id: 'chief-of-staff',
    title: 'Chief of Staff',
    description:
      'Keeps your world in order: triages the noise, preps your meetings, and closes the loop on everything you hand off.',
    icon: SolutionOutlined,
    category: 'operate',
    emoji: '🗂️',
    sourceBranch: 'template/chief-of-staff',
    ...BUILT_IN_TEMPLATE_SOURCE,
  },
  {
    id: 'financial-analyst',
    title: 'Financial Analyst',
    description:
      "Reads the numbers, catches what doesn't add up, and hands you the finding, not a spreadsheet.",
    icon: FundOutlined,
    category: 'operate',
    emoji: '🧮',
    sourceBranch: 'template/financial-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
  },
  {
    id: 'deal-desk',
    title: 'Deal Desk Analyst',
    description: 'Keeps every deal clean, every renewal on time, and every number ready to report.',
    icon: ReconciliationOutlined,
    category: 'grow',
    emoji: '📐',
    sourceBranch: 'template/deal-desk-revops-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
  },
  {
    id: 'sales-outbound',
    title: 'Outbound Analyst',
    description:
      'Builds your target list, researches each prospect, and drafts the outreach. You hit send.',
    icon: AimOutlined,
    category: 'grow',
    emoji: '🎯',
    sourceBranch: 'template/sales-outbound-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
  },
  {
    id: 'legal-analyst',
    title: 'Legal Analyst',
    description:
      'Reads the redline, flags the risk, and tells you what to push back on before it costs you.',
    icon: SafetyOutlined,
    category: 'operate',
    emoji: '⚖️',
    sourceBranch: 'template/legal-analyst',
    ...BUILT_IN_TEMPLATE_SOURCE,
  },
  {
    id: 'builder',
    title: 'Builder',
    description: 'Turns your idea into a working app or dashboard, spun up on a live test env.',
    icon: BuildOutlined,
    category: 'build',
    emoji: '🛠️',
    sourceBranch: 'template/builder',
    ...BUILT_IN_TEMPLATE_SOURCE,
  },
] as const satisfies readonly TeammateTemplate[];

/** Stable source-template identifiers derived from the canonical definitions. */
export type TeammateTemplateId = (typeof TEAMMATE_TEMPLATES)[number]['id'];

/**
 * The blank starter card. Kept separate from TEAMMATE_TEMPLATES so callers can
 * render it first. Onboarding presents it as the recommended "Team assistant". Its
 * `sourceBranch` is the framework repo default; the wiring resolves it to the
 * repo's own default branch (the public template's for a github.com private fork).
 */
export const BLANK_TEMPLATE = {
  id: BLANK_TEMPLATE_ID,
  title: 'Start blank',
  description:
    'No starter playbook. Tell your teammate what to do and which rules to follow, right in the chat.',
  icon: PlusOutlined,
  emoji: '',
  sourceBranch: TEAMMATE_FRAMEWORK_DEFAULT_BRANCH,
} as const satisfies TeammateTemplate;

export type TeammateGalleryCardId = TeammateTemplateId | typeof BLANK_TEMPLATE_ID;

/** Every card shown in the gallery: all templates plus the blank starter. */
export const TEAMMATE_GALLERY_CARDS = [...TEAMMATE_TEMPLATES, BLANK_TEMPLATE] as const;
export type TeammateGalleryCard = (typeof TEAMMATE_GALLERY_CARDS)[number];

export function getTeammateTemplate(id?: string | null): TeammateGalleryCard | undefined {
  return id ? TEAMMATE_GALLERY_CARDS.find((template) => template.id === id) : undefined;
}

/**
 * Source branch a teammate should be cut from for the given template.
 *
 * Real templates force their contract branch; the blank starter (or no
 * selection) returns undefined so branch creation falls back to the framework
 * repo's own default branch (the public template's for a github.com private fork).
 */
export function resolveTemplateSourceBranch(id?: string | null): string | undefined {
  if (!id || id === BLANK_TEMPLATE_ID) return undefined;
  const template = getTeammateTemplate(id);
  if (!template) {
    throw new Error(`Unknown teammate template id: ${id}`);
  }
  return template.sourceBranch;
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
  return TEAMMATE_TEMPLATES.find((template) => template.sourceBranch === branch);
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

/** The gallery's active filter: everything, or a single category. */
export type GalleryFilter = 'all' | TeammateCategoryId;

/**
 * Cards to render for the active filter: `all` leads with the blank starter (so
 * templates never read as required); a category shows only its templates.
 */
export function galleryCardsForFilter(filter: GalleryFilter): readonly TeammateGalleryCard[] {
  if (filter !== 'all') {
    return TEAMMATE_TEMPLATES.filter((template) => template.category === filter);
  }
  return [BLANK_TEMPLATE, ...TEAMMATE_TEMPLATES];
}
