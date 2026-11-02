import { generateKeyPairSync } from 'node:crypto';
import type { AgorConfig } from '@agor/core/config';
import { UsersRepository } from '@agor/core/db';
import type {
  AuthenticatedParams,
  FeatureAnnouncementDTO,
  FeatureAnnouncementItemDTO,
  User,
  UserID,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  buildFeatureAnnouncementsFeed,
  CloudFeatureAnnouncementsPoller,
  FeatureAnnouncementsMarkSeenService,
  FeatureAnnouncementsService,
  featureAnnouncementItemsForAgents,
  mergeFeatureAnnouncementsSeen,
  parseFeatureAnnouncements,
  resolveFeatureAnnouncementsSource,
  shortBrief,
} from './feature-announcements';
import { UsersService } from './users';

const item = (
  id: string,
  overrides: Partial<FeatureAnnouncementItemDTO> = {}
): FeatureAnnouncementItemDTO => ({
  id,
  kind: 'new',
  title: `Item ${id}`,
  one_line: `One line ${id}`,
  learn_more_url: null,
  visual: null,
  visual_alt: null,
  button: null,
  badge: true,
  popup: false,
  new_until: '2026-12-01T00:00:00.000Z',
  roles: 'everyone',
  tenant_ids: null,
  pr_numbers: [],
  agent_brief: `Brief ${id}`,
  ...overrides,
});

const release = (
  id: string,
  publishedAt: string,
  items: FeatureAnnouncementItemDTO[]
): FeatureAnnouncementDTO => ({
  id,
  label: `runtime-${id}`,
  version_label: `Agor ${id}`,
  published_at: publishedAt,
  items,
});

const RELEASES = [
  release('r3', '2026-10-20T00:00:00.000Z', [
    item('r3-launch', { popup: true }),
    item('r3-admin', { popup: true, roles: 'admins' }),
  ]),
  release('r2', '2026-10-10T00:00:00.000Z', [
    item('r2-launch', { popup: true }),
    item('r2-quiet', { badge: false }),
  ]),
  release('r1', '2026-09-01T00:00:00.000Z', [item('r1-launch', { popup: true })]),
];

const member = (preferences: User['preferences'] = {}) => ({
  role: 'member' as const,
  created_at: new Date('2026-09-15T00:00:00.000Z'),
  preferences,
});

const NOW = Date.parse('2026-10-21T00:00:00.000Z');

describe('buildFeatureAnnouncementsFeed', () => {
  it('hides admin items from members and drops releases left empty', () => {
    const feed = buildFeatureAnnouncementsFeed(
      [
        release('admin-only', '2026-10-21T00:00:00.000Z', [item('a', { roles: 'admins' })]),
        ...RELEASES,
      ],
      member(),
      'default',
      NOW
    );

    expect(feed.announcements.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    expect(feed.announcements[0].items.map((i) => i.id)).toEqual(['r3-launch']);
    expect(
      buildFeatureAnnouncementsFeed(RELEASES, { ...member(), role: 'admin' }, 'default', NOW)
        .announcements[0].items
    ).toHaveLength(2);
  });

  it('shows tenant-limited items only to callers in a listed tenant', () => {
    const limited = [
      release('r', '2026-10-20T00:00:00.000Z', [
        item('acme-only', { tenant_ids: ['tenant-acme'] }),
        item('everyone'),
      ]),
    ];
    const idsFor = (tenantId: string | undefined) =>
      buildFeatureAnnouncementsFeed(limited, member(), tenantId, NOW).announcements.flatMap((r) =>
        r.items.map((i) => i.id)
      );

    expect(idsFor('tenant-acme')).toEqual(['acme-only', 'everyone']);
    expect(idsFor('tenant-globex')).toEqual(['everyone']);
    // No trusted tenant: a tenant-limited item stays hidden.
    expect(idsFor(undefined)).toEqual(['everyone']);
  });

  it("never sends audience fields or another tenant's ID to the caller", () => {
    const limited = [
      release('r', '2026-10-20T00:00:00.000Z', [
        item('shared', { tenant_ids: ['tenant-acme', 'tenant-globex'], popup: true }),
      ]),
    ];
    const feed = buildFeatureAnnouncementsFeed(limited, member(), 'tenant-acme', NOW);

    expect(feed.announcements[0].items.map((i) => i.id)).toEqual(['shared']);
    expect(feed.pending_popup_items.map((i) => i.id)).toEqual(['shared']);
    const sent = JSON.stringify(feed);
    expect(sent).not.toContain('tenant-globex');
    expect(sent).not.toContain('tenant_ids');
    expect(sent).not.toContain('roles');
    expect(sent).not.toContain('pr_numbers');
  });

  it('makes one notification per release with a new badge item, never before the account existed', () => {
    const feed = buildFeatureAnnouncementsFeed(RELEASES, member(), 'default', NOW);

    expect(feed.notification_ids).toEqual(['r3', 'r2']);
    expect(feed.unread_notification_ids).toEqual(['r3', 'r2']);
    expect(feed.pending_popup_items.map((i) => i.id)).toEqual(['r3-launch', 'r2-launch']);

    // Quiet items and items past new_until never ring the bell.
    const quiet = buildFeatureAnnouncementsFeed(
      [
        release('q', '2026-10-20T00:00:00.000Z', [
          item('quiet', { badge: false }),
          item('old', { new_until: '2026-10-20T12:00:00.000Z', popup: true }),
        ]),
      ],
      member(),
      'default',
      NOW
    );
    expect(quiet.notification_ids).toEqual([]);
    expect(quiet.pending_popup_items).toEqual([]);
  });

  it('reads notifications by release ID and pop-ups by item ID', () => {
    const opened = buildFeatureAnnouncementsFeed(
      RELEASES,
      member({
        featureAnnouncements: { seenReleaseIds: ['r2', 'r1'], seenPopupItemIds: ['r3-launch'] },
      }),
      'default',
      NOW
    );
    expect(opened.notification_ids).toEqual(['r3', 'r2']);
    expect(opened.unread_notification_ids).toEqual(['r3']);
    expect(opened.announcements.map((r) => [r.id, r.seen])).toEqual([
      ['r3', false],
      ['r2', true],
      ['r1', true],
    ]);
    expect(opened.pending_popup_items.map((i) => i.id)).toEqual(['r2-launch']);
  });

  it('keeps seen state when an operator edits a live item and moves its release time', () => {
    const seen = member({
      featureAnnouncements: {
        seenReleaseIds: ['r3'],
        seenPopupItemIds: ['r3-launch'],
      },
    });
    const [r3, ...rest] = RELEASES;
    // Same release and item IDs; new copy, a new visual and a later published_at.
    const edited: FeatureAnnouncementDTO = {
      ...r3,
      published_at: '2026-10-20T18:00:00.000Z',
      items: r3.items.map((i) =>
        i.id === 'r3-launch'
          ? {
              ...i,
              title: 'Zones arrange your cards for you',
              visual: { type: 'illustration', key: 'zone-grid' },
              visual_alt: 'Cards snap into a grid',
            }
          : i
      ),
    };
    const feed = buildFeatureAnnouncementsFeed([edited, ...rest], seen, 'default', NOW);

    expect(feed.announcements[0].items[0].title).toBe('Zones arrange your cards for you');
    expect(feed.notification_ids).toContain('r3');
    expect(feed.unread_notification_ids).not.toContain('r3');
    expect(feed.pending_popup_items.map((i) => i.id)).not.toContain('r3-launch');
  });

  it('leaves the pop-up window to Agor Cloud for cloud items', () => {
    const later = Date.parse('2026-10-28T00:00:00.000Z');
    // r2 is 18 days old: outside the bundled window, but Cloud still marks it popup.
    expect(
      buildFeatureAnnouncementsFeed(
        RELEASES,
        member(),
        'default',
        later,
        false
      ).pending_popup_items.map((i) => i.id)
    ).toEqual(['r3-launch', 'r2-launch']);
  });

  it('pops up only recent launches and never in the first days of an account', () => {
    const later = Date.parse('2026-10-28T00:00:00.000Z');
    expect(
      buildFeatureAnnouncementsFeed(RELEASES, member(), 'default', later).pending_popup_items.map(
        (i) => i.id
      )
    ).toEqual(['r3-launch']);

    const newcomer = { ...member(), created_at: new Date('2026-10-18T00:00:00.000Z') };
    const feed = buildFeatureAnnouncementsFeed(RELEASES, newcomer, 'default', NOW);
    expect(feed.pending_popup_items).toEqual([]);
    expect(feed.unread_notification_ids).toEqual(['r3']);
  });

  it('reports a source that has not answered yet as unavailable', () => {
    expect(buildFeatureAnnouncementsFeed(null, member(), 'default', NOW)).toMatchObject({
      available: false,
      announcements: [],
      pending_popup_items: [],
    });
    expect(buildFeatureAnnouncementsFeed([], member(), 'default', NOW).available).toBe(true);
  });
});

describe('mergeFeatureAnnouncementsSeen', () => {
  it('keeps the other field and caps IDs to the newest', () => {
    expect(
      mergeFeatureAnnouncementsSeen(
        { seenPopupItemIds: ['a'], seenReleaseIds: ['r1'] },
        { scope: 'release_notes' },
        ['r2', 'r1']
      )
    ).toEqual({ seenPopupItemIds: ['a'], seenReleaseIds: ['r2', 'r1'] });

    const many = Array.from({ length: 200 }, (_, i) => `old-${i}`);
    const merged = mergeFeatureAnnouncementsSeen(
      { seenReleaseIds: ['r1'], seenPopupItemIds: many },
      { scope: 'popup', itemIds: ['old-5', 'new'] }
    );
    expect(merged.seenReleaseIds).toEqual(['r1']);
    expect(merged.seenPopupItemIds).toHaveLength(200);
    expect(merged.seenPopupItemIds?.slice(-2)).toEqual(['old-5', 'new']);
    expect(merged.seenPopupItemIds).not.toContain('old-0');
  });
});

describe('parseFeatureAnnouncements', () => {
  it.each([
    [
      'an http link button',
      { button: { action: 'link', url: 'http://evil.example/', label: 'Go' } },
    ],
    ['an unknown page', { button: { action: 'agor_page', target: 'admin', label: 'Go' } }],
    ['an unknown illustration', { visual: { type: 'illustration', key: 'confetti' } }],
    [
      'media without alt text',
      { visual: { type: 'media', url: 'https://agor.live/x.png', mime: 'image/png' } },
    ],
    ['a long title', { title: 'x'.repeat(61) }],
  ])('drops an item with %s and keeps the rest', (_label, overrides) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [parsed] = parseFeatureAnnouncements([
      release('r', '2026-10-01T00:00:00.000Z', [item('bad', overrides as never), item('good')]),
    ]);
    expect(parsed.items.map((i) => i.id)).toEqual(['good']);
    expect(warn).toHaveBeenCalledWith('[feature-announcements] Dropped 1 invalid item(s)');
    warn.mockRestore();
  });

  it('rejects a malformed release', () => {
    expect(() =>
      parseFeatureAnnouncements([{ ...release('r', 'not a date', [item('i')]) }])
    ).toThrow();
  });

  it('drops media the CSP would block but keeps the item', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const media = (url: string, url_dark?: string) => ({
      visual: { type: 'media' as const, url, url_dark, mime: 'image/png' as const },
      visual_alt: 'Cards in a grid',
    });
    const [parsed] = parseFeatureAnnouncements(
      [
        release('r', '2026-10-01T00:00:00.000Z', [
          item('docs', media('https://agor.live/whats-new/a.png')),
          item('cdn', media('https://cdn.example/a.png')),
          item('console', media('https://console.example/u/a.png')),
          item('dark', media('https://agor.live/a.png', 'https://cdn.example/a-dark.png')),
          item('drawn', { visual: { type: 'illustration', key: 'channels' } }),
        ]),
      ],
      ['https://agor.live', 'https://console.example']
    );

    expect(parsed.items.map((i) => [i.id, i.visual?.type ?? null])).toEqual([
      ['docs', 'media'],
      ['cdn', null],
      ['console', 'media'],
      ['dark', null],
      ['drawn', 'illustration'],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('sorts newest first and drops releases without items', () => {
    expect(
      parseFeatureAnnouncements([
        release('old', '2026-01-01T00:00:00.000Z', [item('a')]),
        release('empty', '2026-12-01T00:00:00.000Z', []),
        release('new', '2026-06-01T00:00:00.000Z', [item('b')]),
      ]).map((r) => r.id)
    ).toEqual(['new', 'old']);
  });
});

describe('featureAnnouncementItemsForAgents', () => {
  it('flattens newest first with seen state, since and limit', () => {
    const feed = buildFeatureAnnouncementsFeed(
      RELEASES,
      member({ featureAnnouncements: { seenReleaseIds: ['r2'] } }),
      'default',
      NOW
    );

    expect(
      featureAnnouncementItemsForAgents(feed, {
        since: new Date('2026-10-01T00:00:00.000Z'),
        limit: 2,
      })
    ).toEqual([
      expect.objectContaining({
        title: 'Item r3-launch',
        one_line: 'One line r3-launch',
        version: 'Agor r3',
        seen_by_user: false,
      }),
      expect.objectContaining({ title: 'Item r2-launch', version: 'Agor r2', seen_by_user: true }),
    ]);
    expect(shortBrief('x '.repeat(200)).length).toBeLessThanOrEqual(160);
  });
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLOUD_ENV = {
  // Cells receive a bare origin (with or without a trailing slash).
  AGOR_CLOUD_API_BASE_URL: 'https://cloud.example/',
  AGOR_CLOUD_CELL_ID: 'cell-1',
  AGOR_CLOUD_RUNTIME_CREDENTIAL_ID: 'cred-1',
  AGOR_CLOUD_RUNTIME_KEY_ID: 'key-1',
  AGOR_CLOUD_RUNTIME_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

describe('resolveFeatureAnnouncementsSource', () => {
  it('prefers config, then the Cloud runtime credential, then the bundled changelog', () => {
    expect(
      resolveFeatureAnnouncementsSource({ feature_announcements: { source: 'off' } }, CLOUD_ENV)
    ).toBe('off');
    expect(resolveFeatureAnnouncementsSource({} as AgorConfig, CLOUD_ENV)).toBe('cloud');
    expect(
      resolveFeatureAnnouncementsSource({} as AgorConfig, {
        ...CLOUD_ENV,
        AGOR_CLOUD_API_BASE_URL: '',
      })
    ).toBe('bundled');
  });
});

describe('CloudFeatureAnnouncementsPoller', () => {
  it('signs the request with the Cell credential and keeps the last good answer on failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ announcements: RELEASES }))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ announcements: [release('bad', 'x', [item('i')])] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poller = new CloudFeatureAnnouncementsPoller(CLOUD_ENV, undefined, fetchImpl);
    expect(poller.announcements()).toBeNull();

    await poller.refresh();
    expect(poller.announcements()?.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://cloud.example/api/internal/runtime/feature-announcements');
    for (const base of ['https://cloud.example', 'https://cloud.example/']) {
      const bare = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ announcements: [] }));
      await new CloudFeatureAnnouncementsPoller(
        { ...CLOUD_ENV, AGOR_CLOUD_API_BASE_URL: base },
        undefined,
        bare
      ).refresh();
      expect(bare.mock.calls[0][0]).toBe(
        'https://cloud.example/api/internal/runtime/feature-announcements'
      );
    }
    const token = (new Headers(init?.headers).get('Authorization') ?? '').slice(7);
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.kid).toBe('key-1');
    expect(
      jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        audience: 'agor-cloud:executor-runs',
        issuer: 'agor-cell:cell-1',
      })
    ).toMatchObject({
      cell_id: 'cell-1',
      credential_id: 'cred-1',
      scope: 'feature_announcements:read',
    });
    expect(jwt.decode(token)).not.toHaveProperty('body_sha256');

    await poller.refresh();
    await poller.refresh();
    expect(poller.announcements()?.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    // One log for the failing transition, not one per poll.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('refuses a non-HTTPS Cloud API', () => {
    expect(
      () =>
        new CloudFeatureAnnouncementsPoller({
          ...CLOUD_ENV,
          AGOR_CLOUD_API_BASE_URL: 'http://cloud/api',
        })
    ).toThrow(/HTTPS/);
  });
});

describe('FeatureAnnouncementsMarkSeenService', () => {
  const provider = { source: 'bundled' as const, announcements: () => RELEASES };

  dbTest('merges concurrent writes inside users.patch without losing either', async ({ db }) => {
    const users = new UsersService(db);
    const created = await users.create({
      email: 'feature-announcements-race@example.test',
      password: 'a unique local test passphrase',
      role: 'member',
    });
    const userId = created.user_id as UserID;
    await users.patch(userId, { preferences: { homeWorkView: 'board' } });
    const params = {
      user: { user_id: userId, email: created.email, role: 'member' },
    } as AuthenticatedParams;
    const service = new FeatureAnnouncementsMarkSeenService(
      new FeatureAnnouncementsService(provider, new UsersRepository(db)),
      { service: () => users }
    );

    // Interleave: every request starts before any write lands.
    await Promise.all([
      service.create({ scope: 'popup', itemIds: ['r3-launch'] }, params),
      service.create({ scope: 'popup', itemIds: ['r2-launch'] }, params),
      service.create({ scope: 'release_notes' }, params),
    ]);

    const stored = await users.get(userId);
    expect(stored.preferences?.homeWorkView).toBe('board');
    // The test user was created after every fixture release, but opening
    // Release notes still records each visible release, not only notifications.
    expect(stored.preferences?.featureAnnouncements?.seenReleaseIds).toEqual(['r3', 'r2', 'r1']);
    expect([...(stored.preferences?.featureAnnouncements?.seenPopupItemIds ?? [])].sort()).toEqual([
      'r2-launch',
      'r3-launch',
    ]);
  });

  dbTest('an edited live release stays read after Release notes was opened', async ({ db }) => {
    const users = new UsersService(db);
    const created = await users.create({
      email: 'feature-announcements-edit@example.test',
      password: 'a unique local test passphrase',
      role: 'member',
    });
    const userId = created.user_id as UserID;
    const params = {
      user: { user_id: userId, email: created.email, role: 'member' },
    } as AuthenticatedParams;
    const publishedAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    let live = [
      release('live', publishedAt(60_000), [
        item('launch', { popup: true, new_until: '2999-01-01T00:00:00.000Z' }),
      ]),
    ];
    const feed = new FeatureAnnouncementsService(
      { source: 'cloud', announcements: () => live },
      new UsersRepository(db)
    );
    const markSeen = new FeatureAnnouncementsMarkSeenService(feed, { service: () => users });

    expect((await feed.find(params)).unread_notification_ids).toEqual(['live']);
    await markSeen.create({ scope: 'release_notes' }, params);
    await markSeen.create({ scope: 'popup', itemIds: ['launch'] }, params);

    // The operator edits the live item; its release now reports a later time.
    live = [
      release('live', publishedAt(3_600_000), [
        item('launch', {
          popup: true,
          new_until: '2999-01-01T00:00:00.000Z',
          title: 'Edited title',
          visual: { type: 'illustration', key: 'channels' },
        }),
      ]),
    ];
    const after = await feed.find(params);
    expect(after.announcements[0].items[0].title).toBe('Edited title');
    expect(after.notification_ids).toEqual(['live']);
    expect(after.unread_notification_ids).toEqual([]);
    expect(after.pending_popup_items).toEqual([]);
  });

  it('rejects malformed requests and unauthenticated callers', async () => {
    const userId = 'user-1' as UserID;
    const params = { user: { user_id: userId, role: 'member' } } as unknown as AuthenticatedParams;
    const patch = vi.fn();
    const service = new FeatureAnnouncementsMarkSeenService(
      new FeatureAnnouncementsService(provider, { findById: vi.fn() }),
      { service: () => ({ patch }) }
    );

    await expect(service.create({ scope: 'popup', itemIds: [] }, params)).rejects.toThrow();
    await expect(service.create({ scope: 'everything' }, params)).rejects.toThrow();
    await expect(
      service.create({ scope: 'release_notes' }, {} as AuthenticatedParams)
    ).rejects.toThrow(/Authentication/);
    expect(patch).not.toHaveBeenCalled();
  });
});
