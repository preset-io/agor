import type {
  AgorClient,
  ReleaseNoteDTO,
  ReleaseNoteItemDTO,
  ReleaseNotesFeed,
} from '@agor-live/client';
import { RELEASE_NOTES_MARK_SEEN_SERVICE, RELEASE_NOTES_SERVICE } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { makeUser } from '../BranchModal/testUtils';
import { ReleaseNotesBell } from './ReleaseNotesBell';
import { ReleaseNotesProvider } from './ReleaseNotesContext';
import { ReleaseNotesDrawer } from './ReleaseNotesDrawer';
import { WhatsNewModal } from './WhatsNewModal';

const item = (id: string, overrides: Partial<ReleaseNoteItemDTO> = {}): ReleaseNoteItemDTO => ({
  id,
  tier: 'update',
  category: 'feature',
  audience: 'all',
  title: `Title ${id}`,
  subtitle: null,
  body_md: `Body ${id}`,
  agent_brief: `Brief ${id}`,
  docs_url: null,
  visual_url: null,
  visual_url_dark: null,
  cta_label: null,
  cta_path: null,
  pr_numbers: [],
  ...overrides,
});

const notes: ReleaseNoteDTO[] = [
  {
    id: 'r2',
    version: '2',
    published_at: '2026-10-20T00:00:00.000Z',
    title: 'Agor 2',
    summary_md: null,
    items: [
      item('zones', {
        tier: 'major',
        title: 'Zones can arrange your cards',
        subtitle: 'Pick a row, a column or a grid and cards snap into place.',
        visual_url: 'https://agor.live/whats-new/zone-layouts-light.svg',
        visual_url_dark: 'https://agor.live/whats-new/zone-layouts-dark.svg',
        cta_label: 'See it on my board',
        cta_path: '/b/:mainBoard/',
        docs_url: 'https://agor.live/guide/boards',
      }),
      item('fix'),
    ],
  },
  {
    id: 'r1',
    version: '1',
    published_at: '2026-10-10T00:00:00.000Z',
    title: 'Agor 1',
    summary_md: null,
    items: [item('search', { tier: 'major', title: 'Faster search' })],
  },
];

const feed = (overrides: Partial<ReleaseNotesFeed> = {}): ReleaseNotesFeed => ({
  source: 'cloud',
  notes,
  last_seen_at: null,
  unread_note_ids: ['r2', 'r1'],
  pending_major_items: [notes[0].items[0], notes[1].items[0]],
  ...overrides,
});

const user = makeUser({ preferences: { mainBoardId: '01a17e45-5b1a-71d0-baed-ed27bc25facf' } });

function setup(initial: ReleaseNotesFeed, { suppressed = false } = {}) {
  const find = vi.fn(async () => initial);
  const create = vi.fn(async () => feed({ unread_note_ids: [], pending_major_items: [] }));
  const service = vi.fn((path: string) => {
    if (path === RELEASE_NOTES_SERVICE) return { find };
    if (path === RELEASE_NOTES_MARK_SEEN_SERVICE) return { create };
    if (path === 'users') return { getPrimaryTeammate: vi.fn(async () => null) };
    throw new Error(`Unexpected service ${path}`);
  });
  const client = { service } as unknown as AgorClient;
  render(
    <ThemeProvider>
      <AntdApp>
        <MemoryRouter>
          <ReleaseNotesProvider client={client} user={user} enabled>
            <ReleaseNotesBell />
            <ReleaseNotesDrawer client={client} user={user} />
            <WhatsNewModal user={user} suppressed={suppressed} />
          </ReleaseNotesProvider>
        </MemoryRouter>
      </AntdApp>
    </ThemeProvider>
  );
  return { find, create };
}

beforeEach(() => {
  localStorage.clear();
});

it('counts unread notes on the bell and marks the drawer seen when opened', async () => {
  const { create } = setup(feed({ pending_major_items: [] }));

  const bell = await screen.findByRole('button', { name: "What's new, 2 unread" });
  fireEvent.click(bell);

  expect(await screen.findByText('Zones can arrange your cards')).toBeInTheDocument();
  expect(screen.getByText('Faster search')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Read the docs' })).toHaveAttribute(
    'href',
    'https://agor.live/guide/boards'
  );
  expect(create).toHaveBeenCalledWith({ scope: 'drawer' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: "What's new" })).toBeInTheDocument()
  );
  // No teammate yet: offer to set one up instead of a dead button.
  expect(screen.getByText('Set up a teammate')).toBeInTheDocument();
});

it('shows unseen majors as one carousel and marks every slide seen on Not now', async () => {
  const { create } = setup(feed());

  expect(await screen.findAllByText('New in Agor')).toHaveLength(2);
  expect(screen.getByText('1 of 2')).toBeInTheDocument();
  // Text queries: role queries compute styles jsdom cannot parse for default antd buttons.
  expect(screen.getByText('See it on my board')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Not now'));

  expect(create).toHaveBeenCalledWith({ scope: 'major', itemIds: ['zones', 'search'] });
  await waitFor(() => expect(screen.queryByText('1 of 2')).not.toBeInTheDocument());
});

it('falls back to text only when the visual fails to load', async () => {
  setup(feed({ pending_major_items: [notes[0].items[0]] }));

  await screen.findByText('Pick a row, a column or a grid and cards snap into place.');
  // The test theme is dark, so the dark visual is the one requested.
  const image = document.querySelector('img[src$="zone-layouts-dark.svg"]');
  expect(image).not.toBeNull();
  fireEvent.error(image as Element);

  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('Zones can arrange your cards')).toBeInTheDocument();
});

it('waits while onboarding is open', async () => {
  const { find } = setup(feed(), { suppressed: true });

  await waitFor(() => expect(find).toHaveBeenCalled());
  expect(screen.queryByText('New in Agor')).not.toBeInTheDocument();
});
