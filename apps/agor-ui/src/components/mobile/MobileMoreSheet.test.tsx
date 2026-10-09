import type { User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { MobileMoreSheet } from './MobileMoreSheet';

function Probe() {
  return <output aria-label="path">{useLocation().pathname}</output>;
}

function renderSheet(props: Partial<React.ComponentProps<typeof MobileMoreSheet>> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenComments: vi.fn(),
    onCreate: vi.fn(),
    onOpenWorkspaceSettings: vi.fn(),
    onOpenUserSettings: vi.fn(),
    onLogout: vi.fn(),
  };
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/m']}>
        <Probe />
        <MobileMoreSheet
          open
          user={{ user_id: 'u1', name: 'Kasia Designer' } as User}
          commentsBadge={3}
          isAdmin={false}
          {...handlers}
          {...props}
        />
      </MemoryRouter>
    </ThemeProvider>
  );
  return handlers;
}

const rowNames = () =>
  Array.from(screen.getByRole('dialog').querySelectorAll('.ant-list-item')).map(
    (row) => row.getAttribute('aria-label') ?? row.textContent
  );

afterEach(() => vi.restoreAllMocks());

describe('MobileMoreSheet', () => {
  it('lists the destinations in order, with no board tree', () => {
    renderSheet();
    expect(rowNames()).toEqual([
      'Profile: Kasia Designer',
      'Create new',
      'Search',
      'Comments and mentions, 3 unread',
      'Knowledge base',
      'Settings',
      'AppearanceLightDark',
      'Documentation',
      'Sign out',
    ]);
    expect(screen.queryByRole('button', { name: /board/i })).not.toBeInTheDocument();
  });

  it('closes before opening each destination', () => {
    const handlers = renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Comments and mentions, 3 unread' }));
    expect(handlers.onClose).toHaveBeenCalled();
    expect(handlers.onOpenComments).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(handlers.onOpenWorkspaceSettings).toHaveBeenCalledWith('boards');
    fireEvent.click(screen.getByRole('button', { name: 'Profile: Kasia Designer' }));
    expect(handlers.onOpenUserSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('status', { name: 'path' })).toHaveTextContent('/m/search');
  });

  it('discloses the shared create flows under Create new, closing the sheet first', () => {
    const handlers = renderSheet();
    const create = screen.getByRole('button', { name: 'Create new' });
    expect(create).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(create);
    expect(create).toHaveAttribute('aria-expanded', 'true');
    for (const label of ['Teammate', 'Branch', 'Board']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Repository' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(handlers.onCreate).toHaveBeenCalledWith('board');
    expect(handlers.onClose.mock.invocationCallOrder[0]).toBeLessThan(
      handlers.onCreate.mock.invocationCallOrder[0]
    );
    expect(create).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists Repository for admins', () => {
    const handlers = renderSheet({ isAdmin: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    fireEvent.click(screen.getByRole('button', { name: 'Repository' }));
    expect(handlers.onCreate).toHaveBeenCalledWith('repository');
  });

  it('hides Create new when the user cannot create (viewers)', () => {
    renderSheet({ onCreate: undefined });
    expect(screen.queryByRole('button', { name: 'Create new' })).not.toBeInTheDocument();
  });

  it('opens a configured external app link in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderSheet({
      externalAppLink: 'https://console.example.test/',
      externalAppLabel: 'Open Agor Cloud',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Agor Cloud' }));
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://console.example.test/',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('opens Documentation in a new tab, just above Sign out', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Documentation' }));
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://agor.live/guide/getting-started',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('omits the external app row for a non-http(s) link', () => {
    renderSheet({ externalAppLink: 'javascript:alert(1)', externalAppLabel: 'Open Agor Cloud' });
    expect(screen.queryByText('Open Agor Cloud')).not.toBeInTheDocument();
  });
});
