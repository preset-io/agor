/**
 * Feature announcements ("What's new"): in-memory platform content plus per-user seen
 * state in `users.data.preferences.featureAnnouncements`. No table: notes are either
 * the CHANGELOG bundled with this daemon or the last good answer from Agor
 * Cloud, which each replica polls on its own.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgorConfig, FEATURE_ANNOUNCEMENTS_CSP_IMG_SRC } from '@agor/core/config';
import type { UsersRepository } from '@agor/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  FEATURE_ANNOUNCEMENT_ITEM_AUDIENCES,
  FEATURE_ANNOUNCEMENT_ITEM_CATEGORIES,
  FEATURE_ANNOUNCEMENT_ITEM_TIERS,
  FEATURE_ANNOUNCEMENTS_LIMITS,
  type FeatureAnnouncementDTO,
  type FeatureAnnouncementsFeed,
  type FeatureAnnouncementsMarkSeenRequest,
  type FeatureAnnouncementsPreferences,
  type FeatureAnnouncementsSource,
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
import {
  type FeatureAnnouncementHighlights,
  parseChangelogFeatureAnnouncements,
} from './feature-announcements-changelog.js';
import { withPreferencesMerge } from './users.js';

/** Contract endpoint, relative to `AGOR_CLOUD_API_BASE_URL` (which ends in `/api`). */
const CLOUD_FEATURE_ANNOUNCEMENTS_PATH = '/internal/runtime/feature-announcements';
const CLOUD_FEATURE_ANNOUNCEMENTS_SCOPE = 'feature_announcements:read';
const CLOUD_POLL_INTERVAL_MS = 15 * 60_000;
const CLOUD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CLOUD_MAX_NOTES = 50;
/** Repository-relative location of the optional OSS highlights sidecar. */
export const FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH =
  'apps/agor-docs/public/whats-new/highlights.json';
/** Its name when the daemon build copies it into dist/. */
const FEATURE_ANNOUNCEMENT_HIGHLIGHTS_FILE = 'highlights.json';

const httpsUrl = z.url().refine((value) => value.startsWith('https://'));
// In-app relative path only: one leading slash, never a protocol-relative URL.
const ctaPath = z.string().regex(/^\/(?!\/)[^\s\\]*$/);

const itemSchema = z.object({
  id: z.string().min(1).max(200),
  tier: z.enum(FEATURE_ANNOUNCEMENT_ITEM_TIERS),
  category: z.enum(FEATURE_ANNOUNCEMENT_ITEM_CATEGORIES),
  audience: z.enum(FEATURE_ANNOUNCEMENT_ITEM_AUDIENCES),
  title: z.string().min(1).max(300),
  subtitle: z.string().max(300).nullable(),
  body_md: z.string().max(20_000),
  agent_brief: z.string().max(4_000),
  docs_url: httpsUrl.nullable(),
  // Checked against the CSP image origin after parsing; see allowedVisual.
  visual_url: z.string().max(2_000).nullable(),
  visual_url_dark: z.string().max(2_000).nullable(),
  cta_label: z.string().max(80).nullable(),
  cta_path: ctaPath.nullable(),
  pr_numbers: z.array(z.number().int().positive()),
});

const noteSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  published_at: z.iso.datetime({ offset: true }),
  title: z.string().min(1).max(300),
  summary_md: z.string().max(20_000).nullable(),
  items: z.array(itemSchema),
});

/**
 * The default CSP is the single source of truth for where visuals may load
 * from; any other host would silently fail in the browser.
 */
function allowedVisual(url: string | null): boolean {
  if (url === null) return true;
  try {
    // Check the scheme too: `blob:https://agor.live/x` also has that origin.
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.origin === FEATURE_ANNOUNCEMENTS_CSP_IMG_SRC;
  } catch {
    return false;
  }
}

/** The one validation gate for both sources; anything the UI renders or navigates to passed it. */
export function parseFeatureAnnouncements(value: unknown): FeatureAnnouncementDTO[] {
  const notes = z.array(noteSchema).max(CLOUD_MAX_NOTES).parse(value);
  let dropped = 0;
  for (const item of notes.flatMap((note) => note.items)) {
    // A visual is optional: drop one we could not load and keep the note.
    for (const key of ['visual_url', 'visual_url_dark'] as const) {
      if (!allowedVisual(item[key])) {
        item[key] = null;
        dropped++;
      }
    }
  }
  if (dropped > 0) {
    console.warn(
      `[feature-announcements] Dropped ${dropped} visual URL(s) outside ${FEATURE_ANNOUNCEMENTS_CSP_IMG_SRC}`
    );
  }
  return notes
    .filter((note) => note.items.length > 0)
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
  notes(): FeatureAnnouncementDTO[] | null;
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
 * The daemon build copies CHANGELOG.md and the highlights sidecar into dist/,
 * so a packaged daemon finds them next to its modules; a source checkout
 * finds the repository copies. Either way they are parsed once at startup.
 */
export function loadBundledFeatureAnnouncements(): FeatureAnnouncementDTO[] {
  const changelog = findUp('CHANGELOG.md');
  if (!changelog) return [];
  const highlightsPath = [
    join(dirname(changelog), FEATURE_ANNOUNCEMENT_HIGHLIGHTS_FILE),
    join(dirname(changelog), FEATURE_ANNOUNCEMENT_HIGHLIGHTS_PATH),
  ].find((path) => existsSync(path));
  const highlights: FeatureAnnouncementHighlights = highlightsPath
    ? JSON.parse(readFileSync(highlightsPath, 'utf8'))
    : {};
  return parseFeatureAnnouncements(
    parseChangelogFeatureAnnouncements(readFileSync(changelog, 'utf8'), highlights)
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

  notes(): FeatureAnnouncementDTO[] | null {
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
        z.object({ announcements: z.unknown() }).parse(body).announcements
      );
      if (this.failing)
        console.log('[feature-announcements] Cloud feature announcements recovered');
      this.failing = false;
    } catch (error) {
      // Log the transition once; keep serving the last good notes.
      if (!this.failing) {
        console.warn(
          '[feature-announcements] Cloud feature announcements refresh failed; keeping cached notes:',
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
  if (source === 'cloud') {
    try {
      return new CloudFeatureAnnouncementsPoller(env).start();
    } catch (error) {
      console.warn(
        '[feature-announcements] Cloud source unavailable; showing no feature announcements:',
        error instanceof Error ? error.message : String(error)
      );
      return { source, notes: () => null };
    }
  }
  let notes: FeatureAnnouncementDTO[] = [];
  if (source === 'bundled') {
    try {
      notes = loadBundledFeatureAnnouncements();
    } catch (error) {
      console.warn(
        '[feature-announcements] Bundled feature announcements are invalid; showing none:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return { source, notes: () => notes };
}

const time = (iso: string | Date | undefined) => (iso ? new Date(iso).getTime() : 0);

/** The caller's audience-filtered notes plus unread and modal state. */
export function buildFeatureAnnouncementsFeed(
  source: FeatureAnnouncementsSource,
  allNotes: FeatureAnnouncementDTO[] | null,
  user: Pick<User, 'role' | 'created_at' | 'preferences'>,
  now = Date.now()
): FeatureAnnouncementsFeed {
  const isAdmin = hasMinimumRole(user.role, ROLES.ADMIN);
  const notes = (allNotes ?? [])
    .map((note) => ({
      ...note,
      items: note.items.filter((item) => item.audience === 'all' || isAdmin),
    }))
    .filter((note) => note.items.length > 0);
  const prefs = user.preferences?.featureAnnouncements ?? {};
  // Majors published before the account existed are history, not news; until
  // the drawer is first opened, neither is anything older than the window.
  const seenBaseline = Math.max(
    time(user.created_at),
    prefs.lastSeenAt
      ? time(prefs.lastSeenAt)
      : now - FEATURE_ANNOUNCEMENTS_LIMITS.firstVisitWindowDays * 86_400_000
  );
  const seenMajor = new Set(prefs.seenMajorItemIds ?? []);
  const unseen = notes.filter((note) => time(note.published_at) > seenBaseline);
  return {
    source,
    available: allNotes !== null,
    notes,
    last_seen_at: prefs.lastSeenAt ?? null,
    unread_note_ids: unseen.map((note) => note.id),
    pending_major_items: unseen
      .flatMap((note) => note.items)
      .filter((item) => item.tier === 'major' && !seenMajor.has(item.id)),
  };
}

const markSeenSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('drawer') }).strict(),
  z
    .object({
      scope: z.literal('major'),
      itemIds: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(FEATURE_ANNOUNCEMENTS_LIMITS.seenMajorItemIds),
    })
    .strict(),
]);

/** Merge a mark-seen request into the stored preference; IDs are capped, newest kept. */
export function mergeFeatureAnnouncementsSeen(
  current: FeatureAnnouncementsPreferences | undefined,
  request: FeatureAnnouncementsMarkSeenRequest,
  now: Date
): FeatureAnnouncementsPreferences {
  if (request.scope === 'drawer') return { ...current, lastSeenAt: now.toISOString() };
  const ids = (current?.seenMajorItemIds ?? []).filter((id) => !request.itemIds.includes(id));
  return {
    ...current,
    seenMajorItemIds: [...ids, ...request.itemIds].slice(
      -FEATURE_ANNOUNCEMENTS_LIMITS.seenMajorItemIds
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

  async feedFor(userId: UserID): Promise<FeatureAnnouncementsFeed> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFound('User not found');
    return buildFeatureAnnouncementsFeed(this.provider.source, this.provider.notes(), user);
  }

  async find(params?: AuthenticatedParams): Promise<FeatureAnnouncementsFeed> {
    return this.feedFor(callerId(params));
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
      throw new BadRequest("Expected { scope: 'drawer' } or { scope: 'major', itemIds }");
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
    return this.feed.feedFor(userId);
  }
}

/** Cut `text` to at most `max` characters on a word boundary, with an ellipsis. */
export function shortBrief(
  text: string,
  max: number = FEATURE_ANNOUNCEMENTS_LIMITS.recentFeatureBriefChars
) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/** Flat newest-first item view for agents (MCP tools and session context). */
export function featureAnnouncementItemsForAgents(
  feed: FeatureAnnouncementsFeed,
  { since, limit }: { since?: Date; limit: number }
) {
  const unread = new Set(feed.unread_note_ids);
  return feed.notes
    .filter((note) => !since || time(note.published_at) >= since.getTime())
    .flatMap((note) =>
      note.items.map((item) => ({
        title: item.title,
        category: item.category,
        tier: item.tier,
        agent_brief: item.agent_brief,
        docs_url: item.docs_url,
        version: note.version,
        published_at: note.published_at,
        seen_by_user: !unread.has(note.id),
      }))
    )
    .slice(0, limit);
}
