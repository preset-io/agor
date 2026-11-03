import type {
  AgorClient,
  FeatureAnnouncementClientItem,
  FeatureAnnouncementClientRelease,
  FeatureAnnouncementsFeed,
  User,
} from '@agor-live/client';
import {
  FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE,
  FEATURE_ANNOUNCEMENTS_SERVICE,
} from '@agor-live/client';
// Label and text queries: role queries compute styles jsdom cannot parse for AntD v6.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { makeUser } from '../BranchModal/testUtils';
import { FeatureAnnouncementsBell } from './FeatureAnnouncementsBell';
import { FeatureAnnouncementsProvider } from './FeatureAnnouncementsContext';
import { NewInAgorModal } from './NewInAgorModal';

const FUTURE = '2099-01-01T00:00:00.000Z';

const item = (
  id: string,
  overrides: Partial<FeatureAnnouncementClientItem> = {}
): FeatureAnnouncementClientItem => ({
  id,
  kind: 'new',
  title: `Title ${id}`,
  one_line: `One line ${id}`,
  learn_more_url: null,
  visual: null,
  visual_alt: null,
  button: null,
  badge: true,
  popup: false,
  new_until: FUTURE,
  roles: 'everyone',
  tenant_ids: null,
  pr_numbers: [],
  agent_brief: `Brief ${id}`,
  ...overrides,
});

const zones = item('zones', {
  title: 'Zones can arrange your cards',
  one_line: 'Pick a row, a column or a grid and cards snap into place.',
  learn_more_url: 'https://agor.live/guide/boards',
  visual: { type: 'illustration', key: 'zone-grid' },
  visual_alt: 'Cards snap into a grid',
  button: { action: 'agor_page', target: 'artifacts', label: 'See it on my board' },
  popup: true,
});
const slack = item('slack', {
  kind: 'improved',
  title: 'Slack setup listens everywhere',
  visual: {
    type: 'media',
    url: 'https://agor.live/whats-new/slack.png',
    url_dark: 'https://agor.live/whats-new/slack-dark.png',
    mime: 'image/png',
  },
  visual_alt: 'Slack channels',
  button: { action: 'link', url: 'https://agor.live/guide/slack', label: 'Open the guide' },
  popup: true,
});

const releases: FeatureAnnouncementClientRelease[] = [
  {
    id: 'r2',
    label: 'runtime-2026-10-28',
    version_label: 'Agor 0.27',
    published_at: '2026-10-28T00:00:00.000Z',
    items: [zones, slack, item('quiet', { badge: false, kind: 'improved' })],
    seen: false,
  },
  {
    id: 'r1',
    label: 'runtime-2026-10-14',
    version_label: 'Agor 0.26',
    published_at: '2026-10-14T00:00:00.000Z',
    items: [item('old', { title: 'Knowledge docs link to each other' })],
    seen: false,
  },
];

const feed = (overrides: Partial<FeatureAnnouncementsFeed> = {}): FeatureAnnouncementsFeed => ({
  available: true,
  announcements: releases,
  notification_ids: ['r2'],
  unread_notification_ids: ['r2'],
  pending_popup_items: [],
  ...overrides,
});

const user = makeUser({ preferences: { mainBoardId: '01a17e45-5b1a-71d0-baed-ed27bc25facf' } });

const LocationProbe = () => <output aria-label="Location">{useLocation().pathname}</output>;

function setup(
  initial: FeatureAnnouncementsFeed,
  {
    suppressed = false,
    afterSeen = feed({ unread_notification_ids: [], pending_popup_items: [] }),
  } = {}
) {
  const find = vi.fn(async () => initial);
  const create = vi.fn(async () => afterSeen);
  const service = vi.fn((path: string) => {
    if (path === FEATURE_ANNOUNCEMENTS_SERVICE) return { find };
    if (path === FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE) return { create };
    if (path === 'users') return { getPrimaryTeammate: vi.fn(async () => null) };
    throw new Error(`Unexpected service ${path}`);
  });
  const client = { service } as unknown as AgorClient;
  const { shell } = renderTab(client, { suppressed });
  return { find, create, shell };
}

/** One browser tab of the app shell; `rerender` swaps in a changed user. */
function renderTab(client: AgorClient, { suppressed = false } = {}) {
  const shell = { openWorkspaceSettings: vi.fn(), openModelSettings: vi.fn() };
  const tree = (tabUser: User) => (
    <ThemeProvider>
      <AntdApp>
        <MemoryRouter>
          <FeatureAnnouncementsProvider client={client} user={tabUser} enabled shell={shell}>
            <FeatureAnnouncementsBell />
            <NewInAgorModal client={client} user={tabUser} suppressed={suppressed} />
            <LocationProbe />
          </FeatureAnnouncementsProvider>
        </MemoryRouter>
      </AntdApp>
    </ThemeProvider>
  );
  const view = render(tree(user));
  return { shell, rerender: (next: User) => view.rerender(tree(next)) };
}

/** A daemon stand-in that persists seen pop-ups the way the real one does. */
function fakeServer(pending: FeatureAnnouncementClientItem[]) {
  const seen = new Set<string>();
  const current = () =>
    feed({ pending_popup_items: pending.filter((popup) => !seen.has(popup.id)) });
  const create = vi.fn(async (body: { itemIds?: string[] }) => {
    for (const id of body.itemIds ?? []) seen.add(id);
    return current();
  });
  const client = {
    service: (path: string) => {
      if (path === FEATURE_ANNOUNCEMENTS_SERVICE) return { find: async () => current() };
      if (path === FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE) return { create };
      throw new Error(`Unexpected service ${path}`);
    },
  } as unknown as AgorClient;
  return { client, create, seen };
}

beforeEach(() => {
  localStorage.clear();
});

it('shows a release as one notification and reads it on Release notes', async () => {
  const { create } = setup(feed());

  fireEvent.click(await screen.findByLabelText('Notifications, 1 unread'));
  const notification = await screen.findByLabelText(
    /Unread: New in Agor: 3 updates. See what's new in Agor 0.27/
  );
  // Opening the bell alone reads nothing; there is no "Mark all as read".
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByText(/mark all/i)).not.toBeInTheDocument();

  fireEvent.click(notification);

  expect(await screen.findByText('Latest: Agor 0.27, Oct 28')).toBeInTheDocument();
  expect(create).toHaveBeenCalledWith({ scope: 'release_notes' });
  expect(screen.getByText('Zones can arrange your cards').closest('a')).toHaveAttribute(
    'href',
    'https://agor.live/guide/boards'
  );
  expect(screen.getByText('Earlier')).toBeInTheDocument();
  expect(screen.getByText('Knowledge docs link to each other')).toBeInTheDocument();
  expect(screen.getByText(/All release notes/).closest('a')).toHaveAttribute(
    'href',
    'https://github.com/preset-io/agor/blob/main/CHANGELOG.md'
  );
  await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument());
});

it('shows empty states when there is nothing to show', async () => {
  setup(feed({ announcements: [], notification_ids: [], unread_notification_ids: [] }));

  fireEvent.click(await screen.findByLabelText('Notifications'));
  expect(await screen.findByText('Nothing new right now')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Release notes'));
  expect(await screen.findByText('No release notes yet')).toBeInTheDocument();
});

it('shows big launches as one carousel and records each slide as it is displayed', async () => {
  // The daemon keeps listing the launch nobody has displayed yet.
  const { create } = setup(feed({ pending_popup_items: [zones, slack] }), {
    afterSeen: feed({ pending_popup_items: [slack] }),
  });

  const dialog = (await screen.findByText('New in Agor')).closest('.ant-modal') as HTMLElement;
  expect(within(dialog).getByText('New in Agor')).toBeInTheDocument();
  expect(within(dialog).getByText('Zones can arrange your cards')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Cards snap into a grid')).toBeInTheDocument();
  expect(within(dialog).getAllByLabelText('Close').length).toBeGreaterThan(0);
  expect(within(dialog).getByText('See it on my board')).toBeInTheDocument();
  expect(within(dialog).getByText('Learn more').closest('a')).toHaveAttribute(
    'href',
    'https://agor.live/guide/boards'
  );
  await waitFor(() => expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['zones'] }));
  expect(create).toHaveBeenCalledTimes(1);

  fireEvent.click(within(dialog).getByLabelText('Next'));
  expect(await within(dialog).findByText('Slack setup listens everywhere')).toBeInTheDocument();
  // The test theme is dark, so the dark picture is the one requested, with its alt text.
  expect(within(dialog).getByAltText('Slack channels')).toHaveAttribute(
    'src',
    'https://agor.live/whats-new/slack-dark.png'
  );
  expect(within(dialog).getByText('Open the guide').closest('a')).toHaveAttribute(
    'href',
    'https://agor.live/guide/slack'
  );

  await waitFor(() => expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['slack'] }));

  // Both slides are already recorded, so closing writes nothing more.
  fireEvent.click(within(dialog).getByText('Not now'));
  await waitFor(() => expect(screen.queryByText('New in Agor')).not.toBeInTheDocument());
  expect(create).toHaveBeenCalledTimes(2);
});

it('closing records the slides that were not displayed', async () => {
  // The daemon keeps listing the launch nobody has displayed yet.
  const { create } = setup(feed({ pending_popup_items: [zones, slack] }), {
    afterSeen: feed({ pending_popup_items: [slack] }),
  });

  fireEvent.click(await screen.findByText('Not now'));

  expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['zones'] });
  expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['slack'] });
});

it('never shows a displayed launch again after a reload or in a second tab', async () => {
  const server = fakeServer([zones, slack]);
  const tabOne = renderTab(server.client);

  // Tab one shows the first slide; displaying it persists it.
  await screen.findByText('Zones can arrange your cards');
  await waitFor(() => expect(server.seen.has('zones')).toBe(true));
  expect(screen.getAllByLabelText('Next')).toHaveLength(1);

  // A second tab opened now gets only the launch nobody has displayed yet.
  renderTab(server.client);
  await waitFor(() => expect(screen.getAllByText('New in Agor')).toHaveLength(2));
  expect(screen.getAllByText('Zones can arrange your cards')).toHaveLength(1);
  expect(screen.getByText('Slack setup listens everywhere')).toBeInTheDocument();
  await waitFor(() => expect(server.seen.has('slack')).toBe(true));

  // Tab one hears of it (users patched) and refetches: its frozen carousel
  // drops the launch it had not reached, so there is no Next to show it again.
  tabOne.rerender({
    ...user,
    preferences: { ...user.preferences, featureAnnouncements: { seenPopupItemIds: ['slack'] } },
  } as User);
  await waitFor(() => expect(screen.queryAllByLabelText('Next')).toHaveLength(0));
  expect(screen.getAllByText('Slack setup listens everywhere')).toHaveLength(1);
  expect(screen.getAllByText('Zones can arrange your cards')).toHaveLength(1);

  // Reload: both launches were displayed, so nothing pops up.
  cleanup();
  renderTab(server.client);
  await screen.findByLabelText('Notifications, 1 unread');
  expect(screen.queryByText('New in Agor')).not.toBeInTheDocument();
});

it('keeps every displayed slide while moving back and forth', async () => {
  const server = fakeServer([zones, slack]);
  renderTab(server.client);

  await screen.findByText('Zones can arrange your cards');
  fireEvent.click(screen.getByLabelText('Next'));
  await screen.findByText('Slack setup listens everywhere');
  // Both are persisted now, so the feed no longer lists either as pending.
  await waitFor(() => expect(server.seen.has('slack')).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 20));

  fireEvent.click(screen.getByLabelText('Previous'));
  expect(await screen.findByText('Zones can arrange your cards')).toBeInTheDocument();
  expect(screen.getByLabelText('Next')).not.toBeDisabled();
  fireEvent.click(screen.getByLabelText('Next'));
  expect(await screen.findByText('Slack setup listens everywhere')).toBeInTheDocument();
  expect(screen.getByLabelText('Previous')).toBeInTheDocument();
});

it('a slow fetch from before a dismissal cannot reopen the pop-up', async () => {
  let resolveStale: (value: FeatureAnnouncementsFeed) => void = () => {};
  const find = vi
    .fn()
    .mockResolvedValueOnce(feed({ pending_popup_items: [zones] }))
    .mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)));
  const create = vi.fn(async () => feed({ pending_popup_items: [] }));
  const client = {
    service: (path: string) => (path === FEATURE_ANNOUNCEMENTS_SERVICE ? { find } : { create }),
  } as unknown as AgorClient;
  const tab = renderTab(client);

  await screen.findByText('Zones can arrange your cards');
  // Another tab records something: this tab refetches, slowly.
  tab.rerender({
    ...user,
    preferences: { ...user.preferences, featureAnnouncements: { seenReleaseIds: ['r1'] } },
  } as User);
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText('Not now'));
  await waitFor(() => expect(screen.queryByText('New in Agor')).not.toBeInTheDocument());

  // The fetch issued before the dismissal answers last, still listing the launch.
  resolveStale(feed({ pending_popup_items: [zones] }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByText('New in Agor')).not.toBeInTheDocument();
});

it('opens the Agor page a button names', async () => {
  const { create, shell } = setup(feed({ pending_popup_items: [zones] }));

  fireEvent.click(await screen.findByText('See it on my board'));
  expect(shell.openWorkspaceSettings).toHaveBeenCalledWith('artifacts');
  expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['zones'] });
});

it('sends people without a teammate to set one up', async () => {
  const chat = item('haiku', {
    title: 'Claude Haiku 5.5 in the model picker',
    button: { action: 'teammate_chat', message: 'Try Haiku 5.5', label: 'Ask my teammate' },
    popup: true,
  });
  const { create } = setup(feed({ pending_popup_items: [chat] }));

  const button = await screen.findByText('Ask my teammate');
  await waitFor(() => expect(button.closest('button')).not.toBeDisabled());
  fireEvent.click(button);

  await waitFor(() => expect(screen.getByLabelText('Location')).toHaveTextContent('/teammates'));
  expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['haiku'] });
});

it('lands All updates on Release notes', async () => {
  const { create } = setup(feed({ pending_popup_items: [zones] }));

  fireEvent.click(await screen.findByText('All updates'));

  expect(await screen.findByText('Latest: Agor 0.27, Oct 28')).toBeInTheDocument();
  expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['zones'] });
  expect(create).toHaveBeenCalledWith({ scope: 'release_notes' });
});

it('drops a picture that fails to load and keeps the copy', async () => {
  setup(feed({ pending_popup_items: [slack] }));

  fireEvent.error(await screen.findByAltText('Slack channels'));

  expect(screen.queryByAltText('Slack channels')).not.toBeInTheDocument();
  expect(screen.getByText('Slack setup listens everywhere')).toBeInTheDocument();
});

it('shows nothing until the source has answered once', async () => {
  const { find } = setup(feed({ available: false, announcements: [] }));

  await waitFor(() => expect(find).toHaveBeenCalled());
  expect(screen.queryByLabelText(/Notifications/)).not.toBeInTheDocument();
  expect(screen.queryByText('New in Agor')).not.toBeInTheDocument();
});

it('does not reopen a seen launch or its notification after an operator edits it', async () => {
  // The daemon's answer once the launch was seen: same IDs, edited copy and visual.
  const edited = {
    ...zones,
    title: 'Zones arrange your cards for you',
    visual: { type: 'illustration' as const, key: 'channels' as const },
  };
  const afterSeen = feed({
    announcements: [{ ...releases[0], items: [edited], seen: true }],
    unread_notification_ids: [],
    pending_popup_items: [],
  });
  const { create } = setup(feed({ pending_popup_items: [zones] }), { afterSeen });

  fireEvent.click(await screen.findByText('Not now'));
  expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['zones'] });

  await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument());
  expect(screen.queryByText('New in Agor')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Notifications'));
  fireEvent.click(await screen.findByText('Release notes'));
  expect(await screen.findByText('Zones arrange your cards for you')).toBeInTheDocument();
  // Every visible release is already seen, so opening Release notes writes nothing.
  expect(create).toHaveBeenCalledTimes(1);
});

it('waits while onboarding is open', async () => {
  const { find } = setup(feed({ pending_popup_items: [zones] }), { suppressed: true });

  await waitFor(() => expect(find).toHaveBeenCalled());
  expect(screen.queryByText('New in Agor')).not.toBeInTheDocument();
});
