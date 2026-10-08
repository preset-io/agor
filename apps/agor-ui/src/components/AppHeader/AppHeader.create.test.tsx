/**
 * The navbar "+" (right of global search) opens the shared CreateMenu and
 * routes the picked flow back to the host via onCreate.
 */

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

describe('AppHeader navbar create button', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('opens the shared create menu and reports the picked flow', async () => {
    const onCreate = vi.fn();
    renderHeader(<AppHeader onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));

    const boardItem = await screen.findByText('New board');
    fireEvent.click(boardItem);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('board'));
  });

  it('renders no create button when onCreate is absent', () => {
    renderHeader(<AppHeader />);
    expect(screen.queryByRole('button', { name: 'Create new' })).toBeNull();
  });
});
