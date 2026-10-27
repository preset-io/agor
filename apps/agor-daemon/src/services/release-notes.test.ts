import { generateKeyPairSync } from 'node:crypto';
import type { AgorConfig } from '@agor/core/config';
import type {
  AuthenticatedParams,
  ReleaseNoteDTO,
  ReleaseNoteItemDTO,
  User,
  UserID,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReleaseNotesFeed,
  CloudReleaseNotesPoller,
  mergeReleaseNotesSeen,
  parseReleaseNotes,
  ReleaseNotesMarkSeenService,
  ReleaseNotesService,
  releaseNoteItemsForAgents,
  resolveReleaseNotesSource,
} from './release-notes';

const item = (id: string, overrides: Partial<ReleaseNoteItemDTO> = {}): ReleaseNoteItemDTO => ({
  id,
  tier: 'update',
  category: 'feature',
  audience: 'all',
  title: `Item ${id}`,
  subtitle: null,
  body_md: 'Body',
  agent_brief: `Brief ${id}`,
  docs_url: null,
  visual_url: null,
  visual_url_dark: null,
  cta_label: null,
  cta_path: null,
  pr_numbers: [],
  ...overrides,
});

const note = (id: string, publishedAt: string, items: ReleaseNoteItemDTO[]): ReleaseNoteDTO => ({
  id,
  version: id,
  published_at: publishedAt,
  title: `Release ${id}`,
  summary_md: null,
  items,
});

const NOTES = [
  note('r3', '2026-10-20T00:00:00.000Z', [
    item('r3-major', { tier: 'major' }),
    item('r3-admin', { tier: 'major', audience: 'admin' }),
  ]),
  note('r2', '2026-10-10T00:00:00.000Z', [item('r2-major', { tier: 'major' }), item('r2-update')]),
  note('r1', '2026-09-01T00:00:00.000Z', [item('r1-major', { tier: 'major' })]),
];

const member = (preferences: User['preferences'] = {}) => ({
  role: 'member' as const,
  created_at: new Date('2026-09-15T00:00:00.000Z'),
  preferences,
});

describe('buildReleaseNotesFeed', () => {
  it('hides admin items from members and drops notes left empty', () => {
    const feed = buildReleaseNotesFeed(
      'bundled',
      [
        note('admin-only', '2026-10-21T00:00:00.000Z', [item('a', { audience: 'admin' })]),
        ...NOTES,
      ],
      member()
    );

    expect(feed.notes.map((n) => n.id)).toEqual(['r3', 'r2', 'r1']);
    expect(feed.notes[0].items.map((i) => i.id)).toEqual(['r3-major']);
    expect(
      buildReleaseNotesFeed('bundled', NOTES, { ...member(), role: 'admin' }).notes[0].items
    ).toHaveLength(2);
  });

  it('shows unseen majors newest first, never ones published before the account existed', () => {
    const feed = buildReleaseNotesFeed('cloud', NOTES, member());

    expect(feed.unread_note_ids).toEqual(['r3', 'r2']);
    expect(feed.pending_major_items.map((i) => i.id)).toEqual(['r3-major', 'r2-major']);
  });

  it('treats majors marked seen, or shipped before the drawer was opened, as seen', () => {
    expect(
      buildReleaseNotesFeed(
        'cloud',
        NOTES,
        member({ releaseNotes: { seenMajorItemIds: ['r3-major'] } })
      ).pending_major_items.map((i) => i.id)
    ).toEqual(['r2-major']);

    const opened = buildReleaseNotesFeed(
      'cloud',
      NOTES,
      member({ releaseNotes: { lastSeenAt: '2026-10-15T00:00:00.000Z' } })
    );
    expect(opened.unread_note_ids).toEqual(['r3']);
    expect(opened.pending_major_items.map((i) => i.id)).toEqual(['r3-major']);
    expect(opened.last_seen_at).toBe('2026-10-15T00:00:00.000Z');
  });
});

describe('mergeReleaseNotesSeen', () => {
  it('keeps the other field and caps major IDs to the newest', () => {
    const now = new Date('2026-10-27T00:00:00.000Z');
    expect(mergeReleaseNotesSeen({ seenMajorItemIds: ['a'] }, { scope: 'drawer' }, now)).toEqual({
      seenMajorItemIds: ['a'],
      lastSeenAt: now.toISOString(),
    });

    const many = Array.from({ length: 200 }, (_, i) => `old-${i}`);
    const merged = mergeReleaseNotesSeen(
      { lastSeenAt: 'x', seenMajorItemIds: many },
      { scope: 'major', itemIds: ['old-5', 'new'] },
      now
    );
    expect(merged.lastSeenAt).toBe('x');
    expect(merged.seenMajorItemIds).toHaveLength(200);
    expect(merged.seenMajorItemIds?.slice(-2)).toEqual(['old-5', 'new']);
    expect(merged.seenMajorItemIds).not.toContain('old-0');
  });
});

describe('parseReleaseNotes', () => {
  it.each([
    ['an external CTA', { cta_path: 'https://evil.example/' }],
    ['a protocol-relative CTA', { cta_path: '//evil.example/' }],
    ['a plain-HTTP visual', { visual_url: 'http://agor.live/x.svg' }],
    ['an unknown tier', { tier: 'hidden' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() =>
      parseReleaseNotes([note('r', '2026-10-01T00:00:00.000Z', [item('i', overrides as never)])])
    ).toThrow();
  });

  it('sorts newest first and drops notes without items', () => {
    expect(
      parseReleaseNotes([
        note('old', '2026-01-01T00:00:00.000Z', [item('a')]),
        note('empty', '2026-12-01T00:00:00.000Z', []),
        note('new', '2026-06-01T00:00:00.000Z', [item('b', { cta_path: '/b/:mainBoard/' })]),
      ]).map((n) => n.id)
    ).toEqual(['new', 'old']);
  });
});

describe('releaseNoteItemsForAgents', () => {
  it('flattens newest first with seen state, since and limit', () => {
    const feed = buildReleaseNotesFeed(
      'cloud',
      NOTES,
      member({ releaseNotes: { lastSeenAt: '2026-10-15T00:00:00.000Z' } })
    );

    expect(
      releaseNoteItemsForAgents(feed, { since: new Date('2026-10-01T00:00:00.000Z'), limit: 2 })
    ).toEqual([
      expect.objectContaining({ title: 'Item r3-major', version: 'r3', seen_by_user: false }),
      expect.objectContaining({ title: 'Item r2-major', version: 'r2', seen_by_user: true }),
    ]);
  });
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLOUD_ENV = {
  AGOR_CLOUD_API_BASE_URL: 'https://cloud.example/api/',
  AGOR_CLOUD_CELL_ID: 'cell-1',
  AGOR_CLOUD_RUNTIME_CREDENTIAL_ID: 'cred-1',
  AGOR_CLOUD_RUNTIME_KEY_ID: 'key-1',
  AGOR_CLOUD_RUNTIME_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

describe('resolveReleaseNotesSource', () => {
  it('prefers config, then the Cloud runtime credential, then the bundled changelog', () => {
    expect(resolveReleaseNotesSource({ release_notes: { source: 'off' } }, CLOUD_ENV)).toBe('off');
    expect(resolveReleaseNotesSource({} as AgorConfig, CLOUD_ENV)).toBe('cloud');
    expect(
      resolveReleaseNotesSource({} as AgorConfig, { ...CLOUD_ENV, AGOR_CLOUD_API_BASE_URL: '' })
    ).toBe('bundled');
  });
});

describe('CloudReleaseNotesPoller', () => {
  it('signs the request with the Cell credential and keeps the last good notes on failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ notes: NOTES }))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ notes: [note('bad', 'x', [item('i', { cta_path: 'https://x' })])] })
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poller = new CloudReleaseNotesPoller(CLOUD_ENV, fetchImpl);

    await poller.refresh();
    expect(poller.notes().map((n) => n.id)).toEqual(['r3', 'r2', 'r1']);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://cloud.example/api/internal/runtime/release-notes');
    const token = (new Headers(init?.headers).get('Authorization') ?? '').slice(7);
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.kid).toBe('key-1');
    expect(
      jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        audience: 'agor-cloud:executor-runs',
        issuer: 'agor-cell:cell-1',
      })
    ).toMatchObject({ cell_id: 'cell-1', credential_id: 'cred-1', scope: 'release_notes:read' });

    await poller.refresh();
    await poller.refresh();
    expect(poller.notes().map((n) => n.id)).toEqual(['r3', 'r2', 'r1']);
    // One log for the failing transition, not one per poll.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('refuses a non-HTTPS Cloud API', () => {
    expect(
      () =>
        new CloudReleaseNotesPoller({ ...CLOUD_ENV, AGOR_CLOUD_API_BASE_URL: 'http://cloud/api' })
    ).toThrow(/HTTPS/);
  });
});

describe('ReleaseNotesMarkSeenService', () => {
  const userId = 'user-1' as UserID;
  const stored = {
    user_id: userId,
    role: 'member',
    created_at: new Date('2026-09-15T00:00:00.000Z'),
    preferences: { mainBoardId: 'board-1', releaseNotes: { seenMajorItemIds: ['r2-major'] } },
  } as unknown as User;
  const params = { user: { user_id: userId, role: 'member' } } as unknown as AuthenticatedParams;

  it('merges into the stored preferences and returns the refreshed feed', async () => {
    const users = { findById: vi.fn(async () => stored) };
    const patch = vi.fn(async (_id: UserID, data: Partial<User>) => {
      Object.assign(stored, data);
      return stored;
    });
    const provider = { source: 'bundled' as const, notes: () => NOTES };
    const service = new ReleaseNotesMarkSeenService(
      new ReleaseNotesService(provider, users),
      users,
      { service: () => ({ patch }) }
    );

    const feed = await service.create({ scope: 'major', itemIds: ['r3-major'] }, params);

    expect(patch).toHaveBeenCalledWith(
      userId,
      {
        preferences: {
          mainBoardId: 'board-1',
          releaseNotes: { seenMajorItemIds: ['r2-major', 'r3-major'] },
        },
      },
      expect.objectContaining({ user: params.user, skipAvatarRefresh: true })
    );
    expect(feed.pending_major_items).toEqual([]);
  });

  it('rejects malformed requests and unauthenticated callers', async () => {
    const users = { findById: vi.fn(async () => stored) };
    const provider = { source: 'bundled' as const, notes: () => NOTES };
    const service = new ReleaseNotesMarkSeenService(
      new ReleaseNotesService(provider, users),
      users,
      { service: () => ({ patch: vi.fn() }) }
    );

    await expect(service.create({ scope: 'major', itemIds: [] }, params)).rejects.toThrow();
    await expect(service.create({ scope: 'everything' }, params)).rejects.toThrow();
    await expect(service.create({ scope: 'drawer' }, {} as AuthenticatedParams)).rejects.toThrow(
      /Authentication/
    );
  });
});
