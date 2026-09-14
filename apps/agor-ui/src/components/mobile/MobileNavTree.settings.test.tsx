import type { Board, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
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
          currentUser={{ role: 'admin' } as User}
          onOpenWorkspaceSettings={onOpenWorkspaceSettings}
          onOpenUserSettings={vi.fn()}
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
