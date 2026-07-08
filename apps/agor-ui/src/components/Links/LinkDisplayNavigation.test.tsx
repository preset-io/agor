import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import { LinkDisplayList } from './LinkDisplayList';
import type { LinkDisplayItem } from './linkDisplay';
import { PinnedLinksStrip } from './PinnedLinksStrip';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

const spaItem: LinkDisplayItem = {
  key: 'kb',
  name: 'Team Doc',
  targetKey: 'ref:agor://kb/team/doc.md',
  category: 'knowledge',
  ownerScope: 'session',
  isPinned: true,
  refUri: 'agor://kb/team/doc.md',
  href: '/kb/team/doc.md',
  navigation: 'spa',
};

const externalItem: LinkDisplayItem = {
  key: 'external',
  name: 'External Docs',
  targetKey: 'url:https://example.com/docs',
  category: 'url',
  ownerScope: 'session',
  isPinned: false,
  url: 'https://example.com/docs',
  href: 'https://example.com/docs',
  navigation: 'external',
};

describe('link display navigation', () => {
  it('renders LinkDisplayList SPA items with basename-aware hrefs and SPA navigation', async () => {
    render(
      <MemoryRouter basename="/ui" initialEntries={['/ui/start']}>
        <LocationProbe />
        <LinkDisplayList items={[spaItem]} />
      </MemoryRouter>
    );

    const link = screen.getByRole('link', { name: 'Team Doc' });
    expect(link).toHaveAttribute('href', '/ui/kb/team/doc.md');

    const eventWasNotCancelled = fireEvent.click(link);
    expect(eventWasNotCancelled).toBe(false);
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/kb/team/doc.md');
    });
  });

  it('renders PinnedLinksStrip SPA items with basename-aware hrefs', () => {
    render(
      <MemoryRouter basename="/ui" initialEntries={['/ui/start']}>
        <PinnedLinksStrip items={[spaItem]} />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Team Doc' })).toHaveAttribute(
      'href',
      '/ui/kb/team/doc.md'
    );
  });

  it('leaves external links as normal browser links', () => {
    render(<LinkDisplayList items={[externalItem]} />);

    expect(screen.getByRole('link', { name: 'External Docs' })).toHaveAttribute(
      'href',
      'https://example.com/docs'
    );
    expect(screen.getByRole('link', { name: 'External Docs' })).toHaveAttribute('target', '_blank');
  });
});
