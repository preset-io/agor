/**
 * The mobile "More" sheet exposes all four create flows via a "Create new"
 * accordion (parity with the desktop navbar "+").
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileMoreSheet } from './MobileMoreSheet';

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));

function renderSheet(onCreate = vi.fn(), onClose = vi.fn()) {
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
        onCreate={onCreate}
      />
    </MemoryRouter>
  );
  return { onCreate, onClose };
}

describe('MobileMoreSheet — Create new', () => {
  it('expands to the four options and opens the picked flow (closing the sheet first)', () => {
    const { onCreate, onClose } = renderSheet();

    fireEvent.click(screen.getByText('Create new'));

    for (const label of ['New AI teammate', 'New branch', 'New board', 'New repository']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByText('New board'));
    expect(onClose).toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith('board');
  });
});
