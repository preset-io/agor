/**
 * The mobile "More" sheet exposes the shared create flows via a "Create new"
 * row (parity with the desktop navbar "+").
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileMoreSheet } from './MobileMoreSheet';

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));

function renderSheet(isAdmin: boolean, { canCreate = true } = {}) {
  const onCreate = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <MobileMoreSheet
        open
        onClose={onClose}
        boardById={new Map()}
        branchById={new Map()}
        sessionsByBranch={new Map()}
        commentById={new Map()}
        onOpenWorkspaceSettings={vi.fn()}
        onOpenUserSettings={vi.fn()}
        onCreate={canCreate ? onCreate : undefined}
        isAdmin={isAdmin}
      />
    </MemoryRouter>
  );
  return { onCreate, onClose };
}

describe('MobileMoreSheet — Create new', () => {
  it('expands in place and opens the picked flow, closing the sheet first', () => {
    const { onCreate, onClose } = renderSheet(false);

    fireEvent.click(screen.getByText('Create new'));

    for (const label of ['Teammate', 'Branch', 'Board']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('Repository')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Board'));
    expect(onClose).toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith('board');
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onCreate.mock.invocationCallOrder[0]);
  });

  it('lists Repository for admins', () => {
    const { onCreate } = renderSheet(true);

    fireEvent.click(screen.getByText('Create new'));
    fireEvent.click(screen.getByText('Repository'));
    expect(onCreate).toHaveBeenCalledWith('repository');
  });

  it('hides the row when the user cannot create (viewers)', () => {
    renderSheet(false, { canCreate: false });
    expect(screen.queryByText('Create new')).not.toBeInTheDocument();
  });
});
