/**
 * Feature announcements ("What's new").
 *
 * The DTOs below are a shared contract with Agor Cloud's
 * `GET /api/internal/runtime/feature-announcements`; self-hosted daemons build the same
 * shape from CHANGELOG.md. Change them only together with the Cloud side.
 */

/** `find` returns the caller's feed; `create` on the sibling path records what they saw. */
export const FEATURE_ANNOUNCEMENTS_SERVICE = 'feature-announcements';
export const FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE = 'feature-announcements/mark-seen';

/** `bundled`: CHANGELOG.md shipped with the daemon. `cloud`: published by Agor Cloud. */
export const FEATURE_ANNOUNCEMENTS_SOURCES = ['bundled', 'cloud', 'off'] as const;
export type FeatureAnnouncementsSource = (typeof FEATURE_ANNOUNCEMENTS_SOURCES)[number];

/** `major` items are also eligible for the in-app modal. */
export const FEATURE_ANNOUNCEMENT_ITEM_TIERS = ['update', 'major'] as const;
export type FeatureAnnouncementItemTier = (typeof FEATURE_ANNOUNCEMENT_ITEM_TIERS)[number];

export const FEATURE_ANNOUNCEMENT_ITEM_CATEGORIES = [
  'feature',
  'improvement',
  'fix',
  'security',
] as const;
export type FeatureAnnouncementItemCategory = (typeof FEATURE_ANNOUNCEMENT_ITEM_CATEGORIES)[number];

export const FEATURE_ANNOUNCEMENT_ITEM_AUDIENCES = ['all', 'admin'] as const;
export type FeatureAnnouncementItemAudience = (typeof FEATURE_ANNOUNCEMENT_ITEM_AUDIENCES)[number];

export interface FeatureAnnouncementItemDTO {
  id: string;
  tier: FeatureAnnouncementItemTier;
  category: FeatureAnnouncementItemCategory;
  audience: FeatureAnnouncementItemAudience;
  title: string;
  /** One line, used by the modal. */
  subtitle: string | null;
  body_md: string;
  /** For AI agents: what it does, when to suggest it, how (UI path / MCP tool). */
  agent_brief: string;
  docs_url: string | null;
  visual_url: string | null;
  visual_url_dark: string | null;
  cta_label: string | null;
  /** In-app relative path; may contain `:currentBoard` / `:mainBoard`. Never an external URL. */
  cta_path: string | null;
  pr_numbers: number[];
}

export interface FeatureAnnouncementDTO {
  id: string;
  version: string;
  published_at: string;
  title: string;
  summary_md: string | null;
  items: FeatureAnnouncementItemDTO[];
}

/** Path tokens a `cta_path` may contain, resolved by the UI. */
export const FEATURE_ANNOUNCEMENT_CTA_TOKENS = {
  currentBoard: ':currentBoard',
  mainBoard: ':mainBoard',
} as const;

/** Per-user state stored at `users.data.preferences.featureAnnouncements`. */
export interface FeatureAnnouncementsPreferences {
  /** ISO time the user last opened the notification drawer. */
  lastSeenAt?: string;
  /** Major item IDs already shown (or dismissed) in the modal, newest last. */
  seenMajorItemIds?: string[];
}

export const FEATURE_ANNOUNCEMENTS_LIMITS = {
  /** Cap on `seenMajorItemIds`; older IDs belong to notes no longer served. */
  seenMajorItemIds: 200,
  /** Items per page for agents. */
  agentListDefault: 20,
  agentListMax: 100,
  /** `agor_sessions_get_current_context.recent_agor_features`. */
  recentFeatureDays: 14,
  recentFeatureMax: 5,
  /** Characters of agent_brief in recent_agor_features; the full brief is in the MCP list. */
  recentFeatureBriefChars: 160,
  /**
   * Until a user first opens the drawer, only notes from this many days count
   * as unread or modal-eligible, so a first visit is not a backlog.
   */
  firstVisitWindowDays: 14,
} as const;

/** What the caller sees: audience-filtered notes plus their own seen state. */
export interface FeatureAnnouncementsFeed {
  source: FeatureAnnouncementsSource;
  /** False until the source has answered once (a Cloud cell before its first good poll). */
  available: boolean;
  /** Newest first. */
  notes: FeatureAnnouncementDTO[];
  last_seen_at: string | null;
  /**
   * Notes published after the drawer was last opened (before the first visit:
   * within `firstVisitWindowDays`), and never before the account was created.
   */
  unread_note_ids: string[];
  /** Major items the modal should show, newest first. */
  pending_major_items: FeatureAnnouncementItemDTO[];
}

export type FeatureAnnouncementsMarkSeenRequest =
  | { scope: 'drawer' }
  | { scope: 'major'; itemIds: string[] };
