/**
 * Feature announcements: in-memory platform content plus per-user seen state in
 * `users.data.preferences.featureAnnouncements`. No table: releases are either
 * the CHANGELOG bundled with this daemon or the last good answer from Agor
 * Cloud, which each replica polls on its own.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgorConfig, FEATURE_ANNOUNCEMENTS_MEDIA_ORIGIN } from '@agor/core/config';
import type { UsersRepository } from '@agor/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  FEATURE_ANNOUNCEMENTS_LIMITS,
  type FeatureAnnouncementDTO,
  type FeatureAnnouncementItemDTO,
  type FeatureAnnouncementsFeed,
  type FeatureAnnouncementsMarkSeenRequest,
  type FeatureAnnouncementsPreferences,
  type FeatureAnnouncementsSource,
  featureAnnouncementHighlightsSchema,
  featureAnnouncementItemSchema,
  featureAnnouncementSchema,
  hasMinimumRole,
  type Params,
  ROLES,
  type User,
  type UserID,
} from '@agor/core/types';
import { z } from 'zod';
import {
  type CloudRuntimeCredential,
  hasCloudRuntimeCredential,
  loadCloudRuntimeCredential,
  readBoundedText,
  signCloudRuntimeAssertion,
} from '../utils/cloud-runtime-credential.js';
import { clip, parseChangelogFeatureAnnouncements } from './feature-announcements-changelog.js';
import { withPreferencesMerge } from './users.js';

/** Contract endpoint, relative to `AGOR_CLOUD_API_BASE_URL` (which ends in `/api`). */
const CLOUD_FEATURE_ANNOUNCEMENTS_PATH = '/internal/runtime/feature-announcements';
const CLOUD_FEATURE_ANNOUNCEMENTS_SCOPE = 'feature_announcements:read';
const CLOUD_POLL_INTERVAL_MS = 15 * 60_000;
const CLOUD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CLOUD_MAX_RELEASES = 50;
const DAY_MS = 86_400_000;
/** Repository-relative location of the OSS highlights file. */
export const FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH =
  'apps/agor-docs/public/whats-new/highlights.json';
/** Its name when the daemon build copies it into dist/. */
const FEATURE_ANNOUNCEMENT_HIGHLIGHTS_FILE = 'highlights.json';

/**
 * The CSP is the single source of truth for where pictures and videos may load
 * from; any other host would silently fail in the browser.
 */
function allowedMedia(url: string | null | undefined, origins: readonly string[]): boolean {
  if (!url) return true;
  try {
    // Check the scheme too: `blob:https://agor.live/x` also has that origin.
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && origins.includes(parsed.origin);
  } catch {
    return false;
  }
}

/** Origins `img-src` / `media-src` allow for announcement media under this config. */
export function featureAnnouncementMediaOrigins(config: AgorConfig): string[] {
  const configured = config.feature_announcements?.media_origin;
  return configured
    ? [FEATURE_ANNOUNCEMENTS_MEDIA_ORIGIN, configured]
    : [FEATURE_ANNOUNCEMENTS_MEDIA_ORIGIN];
}

/**
 * The one validation gate for both sources; anything the UI renders or opens
 * passed it. An invalid item is dropped on its own, so one bad edit or a newer
 * Cloud field value never hides the rest of the feed.
 */
export function parseFeatureAnnouncements(
  value: unknown,
  mediaOrigins: readonly string[] = [FEATURE_ANNOUNCEMENTS_MEDIA_ORIGIN]
): FeatureAnnouncementDTO[] {
  const releases = z.array(featureAnnouncementSchema).max(CLOUD_MAX_RELEASES).parse(value);
  let invalid = 0;
  let droppedMedia = 0;
  const parsed = releases.map((release) => ({
    ...release,
    items: release.items.flatMap((raw): FeatureAnnouncementItemDTO[] => {
      const result = featureAnnouncementItemSchema.safeParse(raw);
      if (!result.success) {
        invalid++;
        return [];
      }
      const item = result.data;
      // A visual is optional: drop one the browser could not load and keep the item.
      if (
        item.visual?.type === 'media' &&
        !(
          allowedMedia(item.visual.url, mediaOrigins) &&
          allowedMedia(item.visual.url_dark, mediaOrigins)
        )
      ) {
        droppedMedia++;
        return [{ ...item, visual: null, visual_alt: null }];
      }
      return [item];
    }),
  }));
  if (invalid > 0) console.warn(`[feature-announcements] Dropped ${invalid} invalid item(s)`);
  if (droppedMedia > 0) {
    console.warn(
      `[feature-announcements] Dropped ${droppedMedia} visual(s) outside ${mediaOrigins.join(', ')}`
    );
  }
  return parsed
    .filter((release) => release.items.length > 0)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

export function resolveFeatureAnnouncementsSource(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env
): FeatureAnnouncementsSource {
  const configured = config.feature_announcements?.source;
  if (configured) return configured;
  return env.AGOR_CLOUD_API_BASE_URL && hasCloudRuntimeCredential(env) ? 'cloud' : 'bundled';
}

export interface FeatureAnnouncementsProvider {
  readonly source: FeatureAnnouncementsSource;
  /** Null until the source has answered once; the UI shows nothing until then. */
  announcements(): FeatureAnnouncementDTO[] | null;
}

/** Walk up from this module to the first directory containing `relative`. */
function findUp(relative: string): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * The daemon build copies CHANGELOG.md and highlights.json into dist/, so a
 * packaged daemon finds them next to its modules; a source checkout finds the
 * repository copies. Either way they are parsed once at startup.
 */
export function loadBundledFeatureAnnouncements(
  mediaOrigins?: readonly string[]
): FeatureAnnouncementDTO[] {
  const changelog = findUp('CHANGELOG.md');
  if (!changelog) return [];
  const highlightsPath = [
    join(dirname(changelog), FEATURE_ANNOUNCEMENT_HIGHLIGHTS_FILE),
    join(dirname(changelog), FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH),
  ].find((path) => existsSync(path));
  const highlights = highlightsPath
    ? featureAnnouncementHighlightsSchema.parse(JSON.parse(readFileSync(highlightsPath, 'utf8')))
        .items
    : {};
  return parseFeatureAnnouncements(
    parseChangelogFeatureAnnouncements(readFileSync(changelog, 'utf8'), highlights),
    mediaOrigins
  );
}

/** Polls Agor Cloud; keeps the last good answer and stays quiet on failure. */
export class CloudFeatureAnnouncementsPoller implements FeatureAnnouncementsProvider {
  readonly source = 'cloud' as const;
  private cached: FeatureAnnouncementDTO[] | null = null;
  private failing = false;
  private readonly url: string;
  private readonly credential: CloudRuntimeCredential;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly mediaOrigins: readonly string[] = [FEATURE_ANNOUNCEMENTS_MEDIA_ORIGIN],
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    const base = new URL(env.AGOR_CLOUD_API_BASE_URL ?? '');
    if (base.protocol !== 'https:' || base.username || base.password) {
      throw new Error('Cloud feature announcements require an HTTPS AGOR_CLOUD_API_BASE_URL');
    }
    this.url = `${base.origin}${base.pathname.replace(/\/+$/, '')}${CLOUD_FEATURE_ANNOUNCEMENTS_PATH}`;
    this.credential = loadCloudRuntimeCredential(env);
  }

  start(): this {
    void this.refresh();
    setInterval(() => void this.refresh(), CLOUD_POLL_INTERVAL_MS).unref();
    return this;
  }

  announcements(): FeatureAnnouncementDTO[] | null {
    return this.cached;
  }

  async refresh(): Promise<void> {
    try {
      // Plain fetch, as in the MCP OAuth relay: the destination is the
      // operator-provisioned Cloud API, which may resolve to a private address.
      const response = await this.fetchImpl(this.url, {
        headers: {
          Authorization: `Bearer ${signCloudRuntimeAssertion(this.credential, {
            scope: CLOUD_FEATURE_ANNOUNCEMENTS_SCOPE,
          })}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const body = JSON.parse(await readBoundedText(response, CLOUD_MAX_RESPONSE_BYTES));
      this.cached = parseFeatureAnnouncements(
        z.object({ announcements: z.unknown() }).parse(body).announcements,
        this.mediaOrigins
      );
      if (this.failing)
        console.log('[feature-announcements] Cloud feature announcements recovered');
      this.failing = false;
    } catch (error) {
      // Log the transition once; keep serving the last good answer.
      if (!this.failing) {
        console.warn(
          '[feature-announcements] Cloud feature announcements refresh failed; keeping the cached ones:',
          error instanceof Error ? error.message : String(error)
        );
      }
      this.failing = true;
    }
  }
}

export function createFeatureAnnouncementsProvider(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env
): FeatureAnnouncementsProvider {
  const source = resolveFeatureAnnouncementsSource(config, env);
  const mediaOrigins = featureAnnouncementMediaOrigins(config);
  if (source === 'cloud') {
    try {
      return new CloudFeatureAnnouncementsPoller(env, mediaOrigins).start();
    } catch (error) {
      console.warn(
        '[feature-announcements] Cloud source unavailable; showing no feature announcements:',
        error instanceof Error ? error.message : String(error)
      );
      return { source, announcements: () => null };
    }
  }
  let announcements: FeatureAnnouncementDTO[] = [];
  if (source === 'bundled') {
    try {
      announcements = loadBundledFeatureAnnouncements(mediaOrigins);
    } catch (error) {
      console.warn(
        '[feature-announcements] Bundled feature announcements are invalid; showing none:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return { source, announcements: () => announcements };
}

const time = (iso: string | Date | undefined) => (iso ? new Date(iso).getTime() : 0);

/** The caller's role- and tenant-filtered releases plus notification and pop-up state. */
export function buildFeatureAnnouncementsFeed(
  source: FeatureAnnouncementsSource,
  all: FeatureAnnouncementDTO[] | null,
  user: Pick<User, 'role' | 'created_at' | 'preferences'>,
  tenantId: string | undefined,
  now = Date.now()
): FeatureAnnouncementsFeed {
  const isAdmin = hasMinimumRole(user.role, ROLES.ADMIN);
  const announcements = (all ?? [])
    .map((release) => ({
      ...release,
      items: release.items.filter(
        (item) =>
          (item.roles === 'everyone' || isAdmin) &&
          // Fails closed: a tenant-limited item needs a trusted caller tenant.
          (item.tenant_ids === null || (!!tenantId && item.tenant_ids.includes(tenantId)))
      ),
    }))
    .filter((release) => release.items.length > 0);
  const prefs = user.preferences?.featureAnnouncements ?? {};
  // Releases published before the account existed are history, not news.
  const created = time(user.created_at);
  const seenBaseline = Math.max(created, time(prefs.lastSeenAt));
  const isNew = (item: FeatureAnnouncementItemDTO) => time(item.new_until) > now;
  const notifications = announcements.filter(
    (release) =>
      time(release.published_at) > created && release.items.some((i) => i.badge && isNew(i))
  );
  const seenPopups = new Set(prefs.seenPopupItemIds ?? []);
  const popupsAllowed = now - created >= FEATURE_ANNOUNCEMENTS_LIMITS.popupNewAccountDays * DAY_MS;
  const popupSince = Math.max(created, now - FEATURE_ANNOUNCEMENTS_LIMITS.popupWindowDays * DAY_MS);
  return {
    source,
    available: all !== null,
    announcements,
    last_seen_at: prefs.lastSeenAt ?? null,
    notification_ids: notifications.map((release) => release.id),
    unread_notification_ids: notifications
      .filter((release) => time(release.published_at) > seenBaseline)
      .map((release) => release.id),
    pending_popup_items: popupsAllowed
      ? announcements
          .filter((release) => time(release.published_at) > popupSince)
          .flatMap((release) => release.items)
          .filter((item) => item.popup && isNew(item) && !seenPopups.has(item.id))
      : [],
  };
}

const markSeenSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('release_notes') }).strict(),
  z
    .object({
      scope: z.literal('popup'),
      itemIds: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(FEATURE_ANNOUNCEMENTS_LIMITS.seenPopupItemIds),
    })
    .strict(),
]);

/** Merge a mark-seen request into the stored preference; IDs are capped, newest kept. */
export function mergeFeatureAnnouncementsSeen(
  current: FeatureAnnouncementsPreferences | undefined,
  request: FeatureAnnouncementsMarkSeenRequest,
  now: Date
): FeatureAnnouncementsPreferences {
  if (request.scope === 'release_notes') return { ...current, lastSeenAt: now.toISOString() };
  const ids = (current?.seenPopupItemIds ?? []).filter((id) => !request.itemIds.includes(id));
  return {
    ...current,
    seenPopupItemIds: [...ids, ...request.itemIds].slice(
      -FEATURE_ANNOUNCEMENTS_LIMITS.seenPopupItemIds
    ),
  };
}

interface FeatureAnnouncementsApp {
  service(path: 'users'): {
    patch(id: UserID, data: Partial<User>, params: Params): Promise<User>;
  };
}

function callerId(params: AuthenticatedParams | undefined): UserID {
  const userId = params?.user?.user_id;
  if (!userId) throw new NotAuthenticated('Authentication required');
  return userId as UserID;
}

/** `GET /feature-announcements`: the caller's feed. Reads only the caller's own user row. */
export class FeatureAnnouncementsService {
  constructor(
    private readonly provider: FeatureAnnouncementsProvider,
    private readonly users: Pick<UsersRepository, 'findById'>
  ) {}

  async feedFor(params: AuthenticatedParams | undefined): Promise<FeatureAnnouncementsFeed> {
    const user = await this.users.findById(callerId(params));
    if (!user) throw new NotFound('User not found');
    return buildFeatureAnnouncementsFeed(
      this.provider.source,
      this.provider.announcements(),
      user,
      params?.tenant?.tenant_id
    );
  }

  async find(params?: AuthenticatedParams): Promise<FeatureAnnouncementsFeed> {
    return this.feedFor(params);
  }
}

/**
 * `POST /feature-announcements/mark-seen`: merges server-side because a users
 * preferences patch replaces the whole object. The write goes through
 * `users.patch` so the caller's other tabs receive the usual `users patched`.
 */
export class FeatureAnnouncementsMarkSeenService {
  constructor(
    private readonly feed: FeatureAnnouncementsService,
    private readonly app: FeatureAnnouncementsApp
  ) {}

  async create(data: unknown, params?: AuthenticatedParams): Promise<FeatureAnnouncementsFeed> {
    const userId = callerId(params);
    const request = markSeenSchema.safeParse(data);
    if (!request.success) {
      throw new BadRequest("Expected { scope: 'release_notes' } or { scope: 'popup', itemIds }");
    }
    const now = new Date();
    // The merge runs inside users.patch, against the row it reads under its
    // per-user lock and compare-and-set write, so concurrent writes survive.
    await this.app.service('users').patch(
      userId,
      {},
      withPreferencesMerge(
        {
          user: params?.user,
          authenticated: true,
          tenant: params?.tenant,
          skipAvatarRefresh: true,
        } as Params,
        (current) => ({
          ...current,
          featureAnnouncements: mergeFeatureAnnouncementsSeen(
            current?.featureAnnouncements,
            request.data,
            now
          ),
        })
      )
    );
    return this.feed.feedFor(params);
  }
}

/** Flat newest-first item view for agents (MCP tools and session context). */
export function featureAnnouncementItemsForAgents(
  feed: FeatureAnnouncementsFeed,
  { since, limit }: { since?: Date; limit: number }
) {
  const lastSeen = time(feed.last_seen_at ?? undefined);
  return feed.announcements
    .filter((release) => !since || time(release.published_at) >= since.getTime())
    .flatMap((release) =>
      release.items.map((item) => ({
        title: item.title,
        kind: item.kind,
        one_line: item.one_line,
        agent_brief: item.agent_brief,
        learn_more_url: item.learn_more_url,
        version: release.version_label,
        published_at: release.published_at,
        seen_by_user: time(release.published_at) <= lastSeen,
      }))
    )
    .slice(0, limit);
}

/** A brief short enough for `recent_agor_features`. */
export const shortBrief = (text: string) =>
  clip(text, FEATURE_ANNOUNCEMENTS_LIMITS.recentFeatureBriefChars);
