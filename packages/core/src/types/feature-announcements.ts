/**
 * Feature announcements: the bell's Release notes and the big-launch pop-up.
 *
 * The schemas below are a shared contract with Agor Cloud's
 * `GET /api/internal/runtime/feature-announcements`; self-hosted daemons build the same
 * shape from CHANGELOG.md plus `highlights.json`. Change them only together with the
 * Cloud side.
 */

import { z } from 'zod';

/** `find` returns the caller's feed; `create` on the sibling path records what they saw. */
export const FEATURE_ANNOUNCEMENTS_SERVICE = 'feature-announcements';
export const FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE = 'feature-announcements/mark-seen';

/** `bundled`: CHANGELOG.md shipped with the daemon. `cloud`: published by Agor Cloud. */
export const FEATURE_ANNOUNCEMENTS_SOURCES = ['bundled', 'cloud', 'off'] as const;
export type FeatureAnnouncementsSource = (typeof FEATURE_ANNOUNCEMENTS_SOURCES)[number];

export const FEATURE_ANNOUNCEMENT_ITEM_KINDS = ['new', 'improved'] as const;
/** Illustration templates the UI draws itself; no image to host. */
export const FEATURE_ANNOUNCEMENT_ILLUSTRATIONS = [
  'zone-grid',
  'channels',
  'screenshot-frame',
] as const;
export const FEATURE_ANNOUNCEMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
] as const;
/** Places in Agor a button can open; the UI owns where each one goes. */
export const FEATURE_ANNOUNCEMENT_AGOR_PAGES = [
  'board',
  'integrations',
  'mcp',
  'teammates',
  'models',
  'artifacts',
] as const;
export type FeatureAnnouncementAgorPage = (typeof FEATURE_ANNOUNCEMENT_AGOR_PAGES)[number];
export const FEATURE_ANNOUNCEMENT_ROLES = ['everyone', 'admins'] as const;

export const FEATURE_ANNOUNCEMENT_TEXT_LIMITS = {
  title: 60,
  oneLine: 120,
  buttonLabel: 40,
} as const;

export type FeatureAnnouncementVisual =
  | { type: 'illustration'; key: (typeof FEATURE_ANNOUNCEMENT_ILLUSTRATIONS)[number] }
  | {
      type: 'media';
      url: string;
      /** Shown in the dark theme when set. */
      url_dark?: string | null;
      mime: (typeof FEATURE_ANNOUNCEMENT_MEDIA_TYPES)[number];
    };

export type FeatureAnnouncementButton =
  | { action: 'agor_page'; target: FeatureAnnouncementAgorPage; label: string }
  | { action: 'link'; url: string; label: string }
  | { action: 'teammate_chat'; message: string; label: string };

/** Everything an editor writes; Cloud and `highlights.json` share it. */
export interface FeatureAnnouncementItemContent {
  kind: (typeof FEATURE_ANNOUNCEMENT_ITEM_KINDS)[number];
  title: string;
  one_line: string;
  learn_more_url: string | null;
  visual: FeatureAnnouncementVisual | null;
  visual_alt: string | null;
  button: FeatureAnnouncementButton | null;
  /** Counts toward the bell badge; otherwise the item is quiet. */
  badge: boolean;
  /** A big launch, shown once in the pop-up. */
  popup: boolean;
  /** The item stops counting as new after this ISO time. */
  new_until: string;
  roles: (typeof FEATURE_ANNOUNCEMENT_ROLES)[number];
  /** For AI agents: what it does, when to suggest it, how (UI path / MCP tool). */
  agent_brief: string;
}

export interface FeatureAnnouncementItemDTO extends FeatureAnnouncementItemContent {
  id: string;
  /** Null: every tenant. Agor Cloud resolves plans and teams to tenant IDs. */
  tenant_ids: string[] | null;
  pr_numbers: number[];
}

/** One release. */
export interface FeatureAnnouncementDTO {
  id: string;
  /** The runtime release, e.g. `runtime-2026-10-28`; the version on self-hosted installs. */
  label: string;
  /** What people read, e.g. "Agor 0.27". */
  version_label: string;
  published_at: string;
  items: FeatureAnnouncementItemDTO[];
}

/**
 * `apps/agor-docs/public/whats-new/highlights.json`: content for released CHANGELOG
 * entries, keyed by preset-io/agor PR number. Every field is optional and defaults
 * from the CHANGELOG entry.
 */
export interface FeatureAnnouncementHighlights {
  version: 2;
  items: Record<string, Partial<FeatureAnnouncementItemContent>>;
}

const httpsUrl = z.url().refine((value) => value.startsWith('https://'), 'Must be an https: URL');

const visualSchema: z.ZodType<FeatureAnnouncementVisual> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('illustration'), key: z.enum(FEATURE_ANNOUNCEMENT_ILLUSTRATIONS) }),
  z.object({
    type: z.literal('media'),
    url: httpsUrl,
    url_dark: httpsUrl.nullish(),
    mime: z.enum(FEATURE_ANNOUNCEMENT_MEDIA_TYPES),
  }),
]);

const buttonLabel = z.string().min(1).max(FEATURE_ANNOUNCEMENT_TEXT_LIMITS.buttonLabel);
const buttonSchema: z.ZodType<FeatureAnnouncementButton> = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('agor_page'),
    target: z.enum(FEATURE_ANNOUNCEMENT_AGOR_PAGES),
    label: buttonLabel,
  }),
  z.object({ action: z.literal('link'), url: httpsUrl, label: buttonLabel }),
  z.object({
    action: z.literal('teammate_chat'),
    message: z.string().min(1).max(4_000),
    label: buttonLabel,
  }),
]);

const itemContentShape = {
  kind: z.enum(FEATURE_ANNOUNCEMENT_ITEM_KINDS),
  title: z.string().min(1).max(FEATURE_ANNOUNCEMENT_TEXT_LIMITS.title),
  one_line: z.string().min(1).max(FEATURE_ANNOUNCEMENT_TEXT_LIMITS.oneLine),
  learn_more_url: httpsUrl.nullable(),
  visual: visualSchema.nullable(),
  visual_alt: z.string().max(300).nullable(),
  button: buttonSchema.nullable(),
  badge: z.boolean(),
  popup: z.boolean(),
  new_until: z.iso.datetime({ offset: true }),
  roles: z.enum(FEATURE_ANNOUNCEMENT_ROLES),
  agent_brief: z.string().max(4_000),
};

const mediaNeedsAlt = (item: Partial<FeatureAnnouncementItemContent>) =>
  item.visual?.type !== 'media' || !!item.visual_alt?.trim();
const altIssue = { message: 'A picture or video needs alt text', path: ['visual_alt'] };

export const featureAnnouncementItemSchema: z.ZodType<FeatureAnnouncementItemDTO> = z
  .object({
    id: z.string().min(1).max(200),
    ...itemContentShape,
    tenant_ids: z.array(z.string().min(1)).nullable(),
    pr_numbers: z.array(z.number().int().positive()),
  })
  .refine(mediaNeedsAlt, altIssue);

/** Items stay unknown here: they are validated one by one so a bad item never hides the rest. */
export const featureAnnouncementSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(100),
  version_label: z.string().min(1).max(100),
  published_at: z.iso.datetime({ offset: true }),
  items: z.array(z.unknown()),
});

export const featureAnnouncementHighlightsSchema: z.ZodType<FeatureAnnouncementHighlights> = z
  .object({
    version: z.literal(2),
    items: z.record(
      z.string().regex(/^[1-9]\d*$/, 'Keys are PR numbers'),
      z.object(itemContentShape).partial().strict().refine(mediaNeedsAlt, altIssue)
    ),
  })
  .strict();

/** Per-user state stored at `users.data.preferences.featureAnnouncements`. */
export interface FeatureAnnouncementsPreferences {
  /** ISO time the user last opened Release notes. */
  lastSeenAt?: string;
  /** Pop-up item IDs already shown (or dismissed), newest last. */
  seenPopupItemIds?: string[];
  /**
   * Releases whose notification was read, newest last. Read state is keyed by
   * release ID so an edit that moves `published_at` never makes it unread again.
   */
  seenReleaseIds?: string[];
}

export const FEATURE_ANNOUNCEMENTS_LIMITS = {
  /** Cap on `seenPopupItemIds`; older IDs belong to releases no longer served. */
  seenPopupItemIds: 200,
  seenReleaseIds: 100,
  /** Items per page for agents. */
  agentListDefault: 20,
  agentListMax: 100,
  /** `agor_sessions_get_current_context.recent_agor_features`. */
  recentFeatureDays: 14,
  recentFeatureMax: 5,
  /** Characters of agent_brief in recent_agor_features; the full brief is in the MCP list. */
  recentFeatureBriefChars: 160,
  /** A big launch pops up only this many days after its release. */
  popupWindowDays: 14,
  /** People in their first days never get pop-ups. */
  popupNewAccountDays: 7,
  /** Self-hosted items count as new this long unless highlights.json says otherwise. */
  bundledNewDays: 30,
} as const;

/** What the caller sees: role- and tenant-filtered releases plus their own seen state. */
export interface FeatureAnnouncementsFeed {
  source: FeatureAnnouncementsSource;
  /** False until the source has answered once (a Cloud cell before its first good poll). */
  available: boolean;
  /** Newest first. */
  announcements: FeatureAnnouncementDTO[];
  last_seen_at: string | null;
  /** Releases shown in Notifications: one per release with a badge item that is still new. */
  notification_ids: string[];
  /**
   * The notifications published after Release notes was last opened, and never
   * before the account was created. The bell badge counts these.
   */
  unread_notification_ids: string[];
  /** Big launches the pop-up should show, newest first. */
  pending_popup_items: FeatureAnnouncementItemDTO[];
}

export type FeatureAnnouncementsMarkSeenRequest =
  | { scope: 'release_notes' }
  | { scope: 'popup'; itemIds: string[] };
