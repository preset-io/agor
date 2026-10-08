/**
 * The navbar "+" (right of global search) opens the shared CreateMenu
 * and routes the picked flow back to the host via onCreate.
 */

import type { User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { AppHeader } from './AppHeader';

vi.mock('../../contexts/ConnectionContext', () => ({
  useConnectionDisabled: () => false,
}));
vi.mock('../BoardSwitcher', () => ({ BoardSwitcher: () => <div /> }));
vi.mock('../BrandLogo', () => ({ BrandLogo: () => <div /> }));
vi.mock('../BrandMark', () => ({ BrandMark: () => <div /> }));
vi.mock('../ConnectionStatus', () => ({ ConnectionStatus: () => null }));
vi.mock('../GlobalUserMenu', () => ({ GlobalUserMenu: () => <div /> }));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));
vi.mock('./GlobalPresenceFacepile', () => ({ GlobalPresenceFacepile: () => <div /> }));
vi.mock('./AppHeaderGlobalSearch', () => ({ AppHeaderGlobalSearch: () => <div /> }));

function renderHeader(node: React.ReactNode) {
  return render(
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      {node}
    </MemoryRouter>
  );
}

const asRole = (role: string) => ({ user_id: 'u1', name: 'U', role }) as unknown as User;

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
  return screen.findAllByRole('menuitem');
}

describe('AppHeader navbar create button', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('lists Teammate, Branch and Board for members, and reports the picked flow', async () => {
    const onCreate = vi.fn();
    renderHeader(<AppHeader user={asRole('member')} onCreate={onCreate} />);

    const items = await openMenu();
    expect(items.map((item) => item.textContent)).toEqual(['Teammate', 'Branch', 'Board']);

    fireEvent.click(screen.getByRole('menuitem', { name: /Board/ }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('board'));
  });

  it('adds Repository for admins', async () => {
    const onCreate = vi.fn();
    renderHeader(<AppHeader user={asRole('admin')} onCreate={onCreate} />);

    const items = await openMenu();
    expect(items.map((item) => item.textContent)).toEqual([
      'Teammate',
      'Branch',
      'Board',
      'Repository',
    ]);

    fireEvent.click(screen.getByRole('menuitem', { name: /Repository/ }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('repository'));
  });

  it('renders no create button when onCreate is absent', () => {
    renderHeader(<AppHeader />);
    expect(screen.queryByRole('button', { name: 'Create new' })).toBeNull();
  });
});
