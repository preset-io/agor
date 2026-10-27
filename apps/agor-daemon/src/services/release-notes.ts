/**
 * Release notes ("What's new"): in-memory platform content plus per-user seen
 * state in `users.data.preferences.releaseNotes`. No table: notes are either
 * the CHANGELOG bundled with this daemon or the last good answer from Agor
 * Cloud, which each replica polls on its own.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgorConfig } from '@agor/core/config';
import type { UsersRepository } from '@agor/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  hasMinimumRole,
  type Params,
  RELEASE_NOTE_ITEM_AUDIENCES,
  RELEASE_NOTE_ITEM_CATEGORIES,
  RELEASE_NOTE_ITEM_TIERS,
  RELEASE_NOTES_LIMITS,
  type ReleaseNoteDTO,
  type ReleaseNotesFeed,
  type ReleaseNotesMarkSeenRequest,
  type ReleaseNotesPreferences,
  type ReleaseNotesSource,
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
  BUNDLED_RELEASE_NOTES_FILE,
  parseChangelogReleaseNotes,
  type ReleaseNoteHighlights,
} from './release-notes-changelog.js';

/** Contract endpoint, relative to `AGOR_CLOUD_API_BASE_URL` (which ends in `/api`). */
const CLOUD_RELEASE_NOTES_PATH = '/internal/runtime/release-notes';
const CLOUD_RELEASE_NOTES_SCOPE = 'release_notes:read';
const CLOUD_POLL_INTERVAL_MS = 15 * 60_000;
const CLOUD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CLOUD_MAX_NOTES = 50;
/** Repository-relative location of the optional OSS highlights sidecar. */
export const RELEASE_NOTE_HIGHLIGHTS_PATH = 'apps/agor-docs/public/whats-new/highlights.json';

const httpsUrl = z.url().refine((value) => value.startsWith('https://'));
// In-app relative path only: one leading slash, never a protocol-relative URL.
const ctaPath = z.string().regex(/^\/(?!\/)[^\s\\]*$/);

const itemSchema = z.object({
  id: z.string().min(1).max(200),
  tier: z.enum(RELEASE_NOTE_ITEM_TIERS),
  category: z.enum(RELEASE_NOTE_ITEM_CATEGORIES),
  audience: z.enum(RELEASE_NOTE_ITEM_AUDIENCES),
  title: z.string().min(1).max(300),
  subtitle: z.string().max(300).nullable(),
  body_md: z.string().max(20_000),
  agent_brief: z.string().max(4_000),
  docs_url: httpsUrl.nullable(),
  visual_url: httpsUrl.nullable(),
  visual_url_dark: httpsUrl.nullable(),
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

/** The one validation gate for both sources; anything the UI renders or navigates to passed it. */
export function parseReleaseNotes(value: unknown): ReleaseNoteDTO[] {
  return z
    .array(noteSchema)
    .max(CLOUD_MAX_NOTES)
    .parse(value)
    .filter((note) => note.items.length > 0)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

export function resolveReleaseNotesSource(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env
): ReleaseNotesSource {
  const configured = config.release_notes?.source;
  if (configured) return configured;
  return env.AGOR_CLOUD_API_BASE_URL && hasCloudRuntimeCredential(env) ? 'cloud' : 'bundled';
}

export interface ReleaseNotesProvider {
  readonly source: ReleaseNotesSource;
  notes(): ReleaseNoteDTO[];
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
 * Packaged daemons read `dist/release-notes.json` written at build time. A
 * source checkout (`pnpm dev`) has none, so it parses the repository
 * CHANGELOG once instead.
 */
export function loadBundledReleaseNotes(): ReleaseNoteDTO[] {
  const built = findUp(BUNDLED_RELEASE_NOTES_FILE);
  if (built) return parseReleaseNotes(JSON.parse(readFileSync(built, 'utf8')));
  const changelog = findUp('CHANGELOG.md');
  if (!changelog) return [];
  const highlightsPath = join(dirname(changelog), RELEASE_NOTE_HIGHLIGHTS_PATH);
  const highlights: ReleaseNoteHighlights = existsSync(highlightsPath)
    ? JSON.parse(readFileSync(highlightsPath, 'utf8'))
    : {};
  return parseReleaseNotes(parseChangelogReleaseNotes(readFileSync(changelog, 'utf8'), highlights));
}

/** Polls Agor Cloud; keeps the last good answer and stays quiet on failure. */
export class CloudReleaseNotesPoller implements ReleaseNotesProvider {
  readonly source = 'cloud' as const;
  private cached: ReleaseNoteDTO[] = [];
  private failing = false;
  private readonly url: string;
  private readonly credential: CloudRuntimeCredential;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    const base = new URL(env.AGOR_CLOUD_API_BASE_URL ?? '');
    if (base.protocol !== 'https:' || base.username || base.password) {
      throw new Error('Cloud release notes require an HTTPS AGOR_CLOUD_API_BASE_URL');
    }
    this.url = `${base.origin}${base.pathname.replace(/\/+$/, '')}${CLOUD_RELEASE_NOTES_PATH}`;
    this.credential = loadCloudRuntimeCredential(env);
  }

  start(): this {
    void this.refresh();
    setInterval(() => void this.refresh(), CLOUD_POLL_INTERVAL_MS).unref();
    return this;
  }

  notes(): ReleaseNoteDTO[] {
    return this.cached;
  }

  async refresh(): Promise<void> {
    try {
      // Plain fetch, as in the MCP OAuth relay: the destination is the
      // operator-provisioned Cloud API, which may resolve to a private address.
      const response = await this.fetchImpl(this.url, {
        headers: {
          Authorization: `Bearer ${signCloudRuntimeAssertion(this.credential, {
            scope: CLOUD_RELEASE_NOTES_SCOPE,
            body: '',
          })}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const body = JSON.parse(await readBoundedText(response, CLOUD_MAX_RESPONSE_BYTES));
      this.cached = parseReleaseNotes(z.object({ notes: z.unknown() }).parse(body).notes);
      if (this.failing) console.log('[release-notes] Cloud release notes recovered');
      this.failing = false;
    } catch (error) {
      // Log the transition once; keep serving the last good notes.
      if (!this.failing) {
        console.warn(
          '[release-notes] Cloud release notes refresh failed; keeping cached notes:',
          error instanceof Error ? error.message : String(error)
        );
      }
      this.failing = true;
    }
  }
}

export function createReleaseNotesProvider(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env
): ReleaseNotesProvider {
  const source = resolveReleaseNotesSource(config, env);
  if (source === 'cloud') {
    try {
      return new CloudReleaseNotesPoller(env).start();
    } catch (error) {
      console.warn(
        '[release-notes] Cloud source unavailable; showing no release notes:',
        error instanceof Error ? error.message : String(error)
      );
      return { source, notes: () => [] };
    }
  }
  let notes: ReleaseNoteDTO[] = [];
  if (source === 'bundled') {
    try {
      notes = loadBundledReleaseNotes();
    } catch (error) {
      console.warn(
        '[release-notes] Bundled release notes are invalid; showing none:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return { source, notes: () => notes };
}

const time = (iso: string | Date | undefined) => (iso ? new Date(iso).getTime() : 0);

/** The caller's audience-filtered notes plus unread and modal state. */
export function buildReleaseNotesFeed(
  source: ReleaseNotesSource,
  allNotes: ReleaseNoteDTO[],
  user: Pick<User, 'role' | 'created_at' | 'preferences'>
): ReleaseNotesFeed {
  const isAdmin = hasMinimumRole(user.role, ROLES.ADMIN);
  const notes = allNotes
    .map((note) => ({
      ...note,
      items: note.items.filter((item) => item.audience === 'all' || isAdmin),
    }))
    .filter((note) => note.items.length > 0);
  const prefs = user.preferences?.releaseNotes ?? {};
  const createdAt = time(user.created_at);
  const seenBaseline = Math.max(createdAt, time(prefs.lastSeenAt));
  const seenMajor = new Set(prefs.seenMajorItemIds ?? []);
  const unseen = notes.filter((note) => time(note.published_at) > seenBaseline);
  return {
    source,
    notes,
    last_seen_at: prefs.lastSeenAt ?? null,
    unread_note_ids: unseen.map((note) => note.id),
    // Majors published before the account existed are history, not news.
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
        .max(RELEASE_NOTES_LIMITS.seenMajorItemIds),
    })
    .strict(),
]);

/** Merge a mark-seen request into the stored preference; IDs are capped, newest kept. */
export function mergeReleaseNotesSeen(
  current: ReleaseNotesPreferences | undefined,
  request: ReleaseNotesMarkSeenRequest,
  now: Date
): ReleaseNotesPreferences {
  if (request.scope === 'drawer') return { ...current, lastSeenAt: now.toISOString() };
  const ids = (current?.seenMajorItemIds ?? []).filter((id) => !request.itemIds.includes(id));
  return {
    ...current,
    seenMajorItemIds: [...ids, ...request.itemIds].slice(-RELEASE_NOTES_LIMITS.seenMajorItemIds),
  };
}

interface ReleaseNotesApp {
  service(path: 'users'): {
    patch(id: UserID, data: Partial<User>, params: Params): Promise<User>;
  };
}

function callerId(params: AuthenticatedParams | undefined): UserID {
  const userId = params?.user?.user_id;
  if (!userId) throw new NotAuthenticated('Authentication required');
  return userId as UserID;
}

/** `GET /release-notes`: the caller's feed. Reads only the caller's own user row. */
export class ReleaseNotesService {
  constructor(
    private readonly provider: ReleaseNotesProvider,
    private readonly users: Pick<UsersRepository, 'findById'>
  ) {}

  async feedFor(userId: UserID): Promise<ReleaseNotesFeed> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFound('User not found');
    return buildReleaseNotesFeed(this.provider.source, this.provider.notes(), user);
  }

  async find(params?: AuthenticatedParams): Promise<ReleaseNotesFeed> {
    return this.feedFor(callerId(params));
  }
}

/**
 * `POST /release-notes/mark-seen`: merges server-side because a users
 * preferences patch replaces the whole object. The write goes through
 * `users.patch` so the caller's other tabs receive the usual `users patched`.
 */
export class ReleaseNotesMarkSeenService {
  constructor(
    private readonly feed: ReleaseNotesService,
    private readonly users: Pick<UsersRepository, 'findById'>,
    private readonly app: ReleaseNotesApp
  ) {}

  async create(data: unknown, params?: AuthenticatedParams): Promise<ReleaseNotesFeed> {
    const userId = callerId(params);
    const request = markSeenSchema.safeParse(data);
    if (!request.success) {
      throw new BadRequest("Expected { scope: 'drawer' } or { scope: 'major', itemIds }");
    }
    const user = await this.users.findById(userId);
    if (!user) throw new NotFound('User not found');
    await this.app.service('users').patch(
      userId,
      {
        preferences: {
          ...user.preferences,
          releaseNotes: mergeReleaseNotesSeen(
            user.preferences?.releaseNotes,
            request.data,
            new Date()
          ),
        },
      },
      {
        user: params?.user,
        authenticated: true,
        tenant: params?.tenant,
        skipAvatarRefresh: true,
      } as Params
    );
    return this.feed.feedFor(userId);
  }
}

/** Flat newest-first item view for agents (MCP tools and session context). */
export function releaseNoteItemsForAgents(
  feed: ReleaseNotesFeed,
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
