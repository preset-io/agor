import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileMoreSheet } from './MobileMoreSheet';

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));

function renderSheet(isAdmin = false) {
  const onClose = vi.fn();
  const onCreate = vi.fn();
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
        isAdmin={isAdmin}
      />
    </MemoryRouter>
  );
  return { onClose, onCreate };
}

describe('MobileMoreSheet Create new', () => {
  it('expands in place, closes the sheet, and opens the picked tab', async () => {
    const { onClose, onCreate } = renderSheet();

    fireEvent.click(screen.getByText('Create new'));
    for (const label of [/Teammate$/, /Branch$/, /Board$/]) {
      expect(await screen.findByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('menuitem', { name: /Repository$/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /Branch$/ }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith('branch');
    expect(onClose).toHaveBeenCalled();
  });

  it('lists Repository for admins', async () => {
    const { onCreate } = renderSheet(true);

    fireEvent.click(screen.getByText('Create new'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Repository$/ }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith('repository');
  });
});
