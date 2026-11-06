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
import { type Application, BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  FEATURE_ANNOUNCEMENTS_CHANGED_EVENT,
  FEATURE_ANNOUNCEMENTS_LIMITS,
  FEATURE_ANNOUNCEMENTS_SERVICE,
  type FeatureAnnouncementClientItem,
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
  type TenantID,
  type User,
  type UserID,
} from '@agor/core/types';
import { z } from 'zod';
import { parseTenantChannelName } from '../realtime/routing.js';
import {
  type CloudRuntimeCredential,
  hasCloudRuntimeCredential,
  loadCloudRuntimeCredential,
  readBoundedText,
  signCloudRuntimeAssertion,
} from '../utils/cloud-runtime-credential.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { clip, parseChangelogFeatureAnnouncements } from './feature-announcements-changelog.js';
import { withPreferencesMerge } from './users.js';

/**
 * Contract endpoint on the Agor Cloud origin. Cells receive `AGOR_CLOUD_API_BASE_URL`
 * as a bare origin, and the executor launcher appends `/api/internal/runtime/...`
 * the same way.
 */
const CLOUD_FEATURE_ANNOUNCEMENTS_PATH = '/api/internal/runtime/feature-announcements';
const CLOUD_FEATURE_ANNOUNCEMENTS_SCOPE = 'feature_announcements:read';
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
  /** Called after the announcements change; only the Cloud source changes after startup. */
  onChange?(listener: () => void): void;
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

/** `feature_announcements.poll_interval_seconds` in milliseconds (validated at config load). */
export function featureAnnouncementsPollIntervalMs(config: AgorConfig): number {
  return (
    (config.feature_announcements?.poll_interval_seconds ??
      FEATURE_ANNOUNCEMENTS_LIMITS.pollIntervalSecondsDefault) * 1000
  );
}

/** Polls Agor Cloud; keeps the last good answer and stays quiet on failure. */
export class CloudFeatureAnnouncementsPoller implements FeatureAnnouncementsProvider {
  readonly source = 'cloud' as const;
  private cached: FeatureAnnouncementDTO[] | null = null;
  private failing = false;
  private readonly listeners: Array<() => void> = [];
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
    this.url = `${base.origin}${CLOUD_FEATURE_ANNOUNCEMENTS_PATH}`;
    this.credential = loadCloudRuntimeCredential(env);
  }

  start(intervalMs = featureAnnouncementsPollIntervalMs({})): this {
    void this.refresh();
    setInterval(() => void this.refresh(), intervalMs).unref();
    return this;
  }

  announcements(): FeatureAnnouncementDTO[] | null {
    return this.cached;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
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
      const next = parseFeatureAnnouncements(
        z.object({ announcements: z.unknown() }).parse(body).announcements,
        this.mediaOrigins
      );
      const changed = JSON.stringify(next) !== JSON.stringify(this.cached);
      this.cached = next;
      if (changed) for (const listener of this.listeners) listener();
      // Debug level: shown in development, filtered out by default in production.
      console.debug(`[feature-announcements] Cloud poll ok: ${this.cached.length} announcement(s)`);
      if (this.failing)
        console.log('[feature-announcements] Cloud feature announcements recovered');
      this.failing = false;
    } catch (error) {
      // Log the transition once; keep serving the last good answer, if any.
      if (!this.failing) {
        console.warn(
          this.cached
            ? '[feature-announcements] Cloud feature announcements refresh failed; keeping the last good answer:'
            : '[feature-announcements] Cloud feature announcements refresh failed; showing none until it succeeds:',
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
      return new CloudFeatureAnnouncementsPoller(env, mediaOrigins).start(
        featureAnnouncementsPollIntervalMs(config)
      );
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

/** The browser and agent view of an item: audience and PR fields stay on the daemon. */
function toClientItem({
  roles: _roles,
  tenant_ids: _tenantIds,
  pr_numbers: _prNumbers,
  ...item
}: FeatureAnnouncementItemDTO): FeatureAnnouncementClientItem {
  return item;
}

/**
 * The caller's role- and tenant-filtered releases plus notification and pop-up state.
 * `popupWindow` applies the 14-day pop-up window; Agor Cloud already sends
 * `popup: false` outside it, so only the bundled source needs it here.
 */
export function buildFeatureAnnouncementsFeed(
  all: FeatureAnnouncementDTO[] | null,
  user: Pick<User, 'role' | 'created_at' | 'preferences'>,
  tenantId: string | undefined,
  now = Date.now(),
  popupWindow = true
): FeatureAnnouncementsFeed {
  const isAdmin = hasMinimumRole(user.role, ROLES.ADMIN);
  const prefs = user.preferences?.featureAnnouncements ?? {};
  // Read state is keyed by stable IDs only (see FeatureAnnouncementsPreferences).
  const seenReleases = new Set(prefs.seenReleaseIds ?? []);
  const seenPopups = new Set(prefs.seenPopupItemIds ?? []);
  const visible = (all ?? [])
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
  // Releases published before the account existed are history, not news.
  const created = time(user.created_at);
  const isNew = (item: FeatureAnnouncementItemDTO) => time(item.new_until) > now;
  const notificationIds = visible
    .filter(
      (release) =>
        time(release.published_at) > created && release.items.some((i) => i.badge && isNew(i))
    )
    .map((release) => release.id);
  const popupsAllowed = now - created >= FEATURE_ANNOUNCEMENTS_LIMITS.popupNewAccountDays * DAY_MS;
  // Bundled only: mirrors Agor Cloud's deliveryItem window; see popupWindowDays.
  const popupSince = popupWindow
    ? Math.max(created, now - FEATURE_ANNOUNCEMENTS_LIMITS.popupWindowDays * DAY_MS)
    : created;
  return {
    available: all !== null,
    announcements: visible.map((release) => ({
      ...release,
      items: release.items.map(toClientItem),
      seen: seenReleases.has(release.id),
    })),
    notification_ids: notificationIds,
    unread_notification_ids: notificationIds.filter((id) => !seenReleases.has(id)),
    pending_popup_items: popupsAllowed
      ? visible
          .filter((release) => time(release.published_at) > popupSince)
          .flatMap((release) => release.items)
          .filter((item) => item.popup && isNew(item) && !seenPopups.has(item.id))
          .map(toClientItem)
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

/** Append `added` to `ids`, keeping each once and only the newest `max`. */
const appendCapped = (ids: string[] | undefined, added: string[], max: number) =>
  [...(ids ?? []).filter((id) => !added.includes(id)), ...added].slice(-max);

/**
 * Merge a mark-seen request into the stored preference. Opening Release notes
 * records every release visible at that moment (`visibleReleaseIds`), whether
 * or not it was a notification.
 */
export function mergeFeatureAnnouncementsSeen(
  current: FeatureAnnouncementsPreferences | undefined,
  request: FeatureAnnouncementsMarkSeenRequest,
  visibleReleaseIds: string[] = []
): FeatureAnnouncementsPreferences {
  if (request.scope === 'release_notes') {
    return {
      ...current,
      seenReleaseIds: appendCapped(
        current?.seenReleaseIds,
        visibleReleaseIds,
        FEATURE_ANNOUNCEMENTS_LIMITS.seenReleaseIds
      ),
    };
  }
  return {
    ...current,
    seenPopupItemIds: appendCapped(
      current?.seenPopupItemIds,
      request.itemIds,
      FEATURE_ANNOUNCEMENTS_LIMITS.seenPopupItemIds
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
  /** Custom realtime event, published per tenant by notifyFeatureAnnouncementsChanged. */
  readonly events = [FEATURE_ANNOUNCEMENTS_CHANGED_EVENT];

  constructor(
    private readonly provider: FeatureAnnouncementsProvider,
    private readonly users: Pick<UsersRepository, 'findById'>
  ) {}

  async feedFor(params: AuthenticatedParams | undefined): Promise<FeatureAnnouncementsFeed> {
    const user = await this.users.findById(callerId(params));
    if (!user) throw new NotFound('User not found');
    return buildFeatureAnnouncementsFeed(
      this.provider.announcements(),
      user,
      params?.tenant?.tenant_id,
      Date.now(),
      this.provider.source === 'bundled'
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
    const visibleReleaseIds =
      request.data.scope === 'release_notes'
        ? (await this.feed.feedFor(params)).announcements.map((release) => release.id)
        : [];
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
            visibleReleaseIds
          ),
        })
      )
    );
    return this.feed.feedFor(params);
  }
}

/**
 * Tell open tabs that the announcements changed. The announcements are
 * platform content, so every tenant with a connected socket on this replica
 * hears a content-free event, published with that tenant as explicit context
 * so the realtime policy routes it to that tenant's channel only.
 */
export function notifyFeatureAnnouncementsChanged(app: Application & { channels: string[] }): void {
  for (const tenantId of new Set(app.channels.map(parseTenantChannelName))) {
    if (!tenantId) continue;
    emitServiceEvent(app, {
      path: FEATURE_ANNOUNCEMENTS_SERVICE,
      event: FEATURE_ANNOUNCEMENTS_CHANGED_EVENT,
      method: 'find',
      data: {},
      params: { tenant: { tenant_id: tenantId as TenantID, source: 'explicit' } },
    });
  }
}

/** Flat newest-first item view for agents (MCP tools and session context). */
export function featureAnnouncementItemsForAgents(
  feed: FeatureAnnouncementsFeed,
  { since, limit }: { since?: Date; limit: number }
) {
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
        seen_by_user: release.seen,
      }))
    )
    .slice(0, limit);
}

/** A brief short enough for `recent_agor_features`. */
export const shortBrief = (text: string) =>
  clip(text, FEATURE_ANNOUNCEMENTS_LIMITS.recentFeatureBriefChars);
