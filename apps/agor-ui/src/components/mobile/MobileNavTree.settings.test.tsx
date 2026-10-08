import type { Board } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileNavTree } from './MobileNavTree';

describe('MobileNavTree settings navigation', () => {
  it('names both compact board destinations for assistive technology', () => {
    render(
      <MemoryRouter>
        <MobileNavTree
          boardById={new Map([['board-1', { board_id: 'board-1', name: 'Delivery' } as Board]])}
          branchById={new Map()}
          sessionsByBranch={new Map()}
          commentById={new Map()}
          onOpenWorkspaceSettings={vi.fn()}
          onOpenUserSettings={vi.fn()}
          onCreate={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: 'Open Delivery board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open comments for Delivery' })).toBeInTheDocument();
  });

  // The cramped 12-item accordion is retired: a single entry opens the shared,
  // full-screen SettingsModal (which owns its own section list on mobile).
  it('opens the shared settings surface from a single entry', () => {
    const onOpenWorkspaceSettings = vi.fn();
    const onNavigate = vi.fn();
    render(
      <MemoryRouter>
        <MobileNavTree
          boardById={new Map()}
          branchById={new Map()}
          sessionsByBranch={new Map()}
          commentById={new Map()}
          onOpenWorkspaceSettings={onOpenWorkspaceSettings}
          onOpenUserSettings={vi.fn()}
          onCreate={vi.fn()}
          onNavigate={onNavigate}
        />
      </MemoryRouter>
    );

    expect(screen.queryByText('Gateway Channels')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Workspace settings'));
    expect(onOpenWorkspaceSettings).toHaveBeenCalledWith('boards');
    expect(onNavigate).toHaveBeenCalled();
  });
});

describe('MobileNavTree external app link', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderNavTree(externalAppLink?: string) {
    const onNavigate = vi.fn();
    render(
      <MemoryRouter>
        <MobileNavTree
          boardById={new Map()}
          branchById={new Map()}
          sessionsByBranch={new Map()}
          commentById={new Map()}
          onOpenWorkspaceSettings={vi.fn()}
          onOpenUserSettings={vi.fn()}
          onNavigate={onNavigate}
          externalAppLink={externalAppLink}
          externalAppLabel="Open Agor Cloud"
        />
      </MemoryRouter>
    );
    return onNavigate;
  }

  it('opens the configured link in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onNavigate = renderNavTree('https://console.example.test/');

    fireEvent.click(screen.getByText('Open Agor Cloud'));

    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://console.example.test/',
      '_blank',
      'noopener,noreferrer'
    );
    expect(onNavigate).toHaveBeenCalled();
  });

  it('omits the row for a non-http(s) link', () => {
    renderNavTree('javascript:alert(1)');

    expect(screen.queryByText('Open Agor Cloud')).not.toBeInTheDocument();
  });
});
