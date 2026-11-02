import type {
  AgorClient,
  FeatureAnnouncementDTO,
  FeatureAnnouncementItemDTO,
  FeatureAnnouncementsFeed,
} from '@agor-live/client';
import {
  FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE,
  FEATURE_ANNOUNCEMENTS_SERVICE,
} from '@agor-live/client';
// Label and text queries: role queries compute styles jsdom cannot parse for AntD v6.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  overrides: Partial<FeatureAnnouncementItemDTO> = {}
): FeatureAnnouncementItemDTO => ({
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

const releases: FeatureAnnouncementDTO[] = [
  {
    id: 'r2',
    label: 'runtime-2026-10-28',
    version_label: 'Agor 0.27',
    published_at: '2026-10-28T00:00:00.000Z',
    items: [zones, slack, item('quiet', { badge: false, kind: 'improved' })],
  },
  {
    id: 'r1',
    label: 'runtime-2026-10-14',
    version_label: 'Agor 0.26',
    published_at: '2026-10-14T00:00:00.000Z',
    items: [item('old', { title: 'Knowledge docs link to each other' })],
  },
];

const feed = (overrides: Partial<FeatureAnnouncementsFeed> = {}): FeatureAnnouncementsFeed => ({
  source: 'cloud',
  available: true,
  announcements: releases,
  last_seen_at: null,
  notification_ids: ['r2'],
  unread_notification_ids: ['r2'],
  pending_popup_items: [],
  ...overrides,
});

const user = makeUser({ preferences: { mainBoardId: '01a17e45-5b1a-71d0-baed-ed27bc25facf' } });

const LocationProbe = () => <output aria-label="Location">{useLocation().pathname}</output>;

function setup(initial: FeatureAnnouncementsFeed, { suppressed = false } = {}) {
  const find = vi.fn(async () => initial);
  const create = vi.fn(async () => feed({ unread_notification_ids: [], pending_popup_items: [] }));
  const service = vi.fn((path: string) => {
    if (path === FEATURE_ANNOUNCEMENTS_SERVICE) return { find };
    if (path === FEATURE_ANNOUNCEMENTS_MARK_SEEN_SERVICE) return { create };
    if (path === 'users') return { getPrimaryTeammate: vi.fn(async () => null) };
    throw new Error(`Unexpected service ${path}`);
  });
  const shell = { openWorkspaceSettings: vi.fn(), openModelSettings: vi.fn() };
  const client = { service } as unknown as AgorClient;
  render(
    <ThemeProvider>
      <AntdApp>
        <MemoryRouter>
          <FeatureAnnouncementsProvider client={client} user={user} enabled shell={shell}>
            <FeatureAnnouncementsBell />
            <NewInAgorModal client={client} user={user} suppressed={suppressed} />
            <LocationProbe />
          </FeatureAnnouncementsProvider>
        </MemoryRouter>
      </AntdApp>
    </ThemeProvider>
  );
  return { find, create, shell };
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

it('shows big launches as one carousel and marks every slide seen on Not now', async () => {
  const { create } = setup(feed({ pending_popup_items: [zones, slack] }));

  const dialog = (await screen.findByText('New in Agor')).closest('.ant-modal') as HTMLElement;
  expect(within(dialog).getByText('New in Agor')).toBeInTheDocument();
  expect(within(dialog).getByText('Zones can arrange your cards')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Cards snap into a grid')).toBeInTheDocument();
  expect(within(dialog).getAllByLabelText('Close').length).toBeGreaterThan(0);
  expect(within(dialog).getByText('See it on my board')).toBeInTheDocument();

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

  fireEvent.click(within(dialog).getByText('Not now'));
  expect(create).toHaveBeenCalledWith({ scope: 'popup', itemIds: ['zones', 'slack'] });
  await waitFor(() => expect(screen.queryByText('New in Agor')).not.toBeInTheDocument());
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

it('waits while onboarding is open', async () => {
  const { find } = setup(feed({ pending_popup_items: [zones] }), { suppressed: true });

  await waitFor(() => expect(find).toHaveBeenCalled());
  expect(screen.queryByText('New in Agor')).not.toBeInTheDocument();
});
