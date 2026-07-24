import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetThemeMode = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../contexts/ConnectionContext', () => ({
  useConnectionDisabled: () => false,
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode: mockSetThemeMode }),
}));

vi.mock('../BoardSwitcher', () => ({
  BoardSwitcher: () => <div data-testid="board-switcher" />,
}));
vi.mock('../BrandLogo', () => ({
  BrandLogo: () => <div data-testid="brand-logo" />,
}));
vi.mock('../ConnectionStatus', () => ({
  ConnectionStatus: () => null,
}));
vi.mock('../GlobalSearch', () => ({
  GlobalSearch: () => <div data-testid="global-search" />,
}));
vi.mock('../GlobalUserMenu', () => ({
  GlobalUserMenu: () => <div data-testid="global-user-menu" />,
}));
vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: () => <div data-testid="markdown-renderer" />,
}));
vi.mock('./GlobalPresenceFacepile', () => ({
  GlobalPresenceFacepile: () => <div data-testid="presence-facepile" />,
}));

function renderHeader(props?: Partial<React.ComponentProps<typeof AppHeader>>) {
  return render(
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <AppHeader {...props} />
    </MemoryRouter>
  );
}

describe('AppHeader settings dropdown', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockSetThemeMode.mockClear();
  });

  it('shows Knowledge Base and Knowledge Settings as flat items', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    expect(await screen.findByText('Knowledge Base')).toBeInTheDocument();
    expect(screen.getByText('Knowledge Settings')).toBeInTheDocument();
  });

  it('navigates to /knowledge via SPA navigation when Knowledge Base is clicked', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const knowledgeBase = await screen.findByText('Knowledge Base');
    fireEvent.click(knowledgeBase);

    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith('/knowledge');
  });

  it('renders Knowledge Base as a basename-aware link for modified clicks and new tabs', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const knowledgeBaseLink = await screen.findByRole('link', { name: 'Knowledge Base' });
    expect(knowledgeBaseLink).toHaveAttribute('href', '/ui/knowledge');
  });

  it('lets modified clicks on Knowledge Base fall through to the browser', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const knowledgeBaseLink = await screen.findByRole('link', { name: 'Knowledge Base' });
    knowledgeBaseLink.removeAttribute('href');

    const eventWasNotCancelled = fireEvent.click(knowledgeBaseLink, { metaKey: true });

    expect(eventWasNotCancelled).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to /knowledge?settings=1 when Knowledge Settings is clicked', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const knowledgeSettings = await screen.findByText('Knowledge Settings');
    fireEvent.click(knowledgeSettings);

    expect(mockNavigate).toHaveBeenCalledWith('/knowledge?settings=1');
  });

  it('invokes onEventStreamClick when Live Events is clicked', async () => {
    const onEventStreamClick = vi.fn();
    renderHeader({ eventStreamEnabled: true, onEventStreamClick });

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const liveEventsItem = await screen.findByText('Live Events');
    fireEvent.click(liveEventsItem);

    expect(onEventStreamClick).toHaveBeenCalledOnce();
  });

  it('invokes onSettingsClick when main Settings is clicked', async () => {
    const onSettingsClick = vi.fn();
    renderHeader({ onSettingsClick });

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const settingsItem = await screen.findByText('Settings');
    fireEvent.click(settingsItem);

    expect(onSettingsClick).toHaveBeenCalledOnce();
  });

  it('calls setThemeMode with the correct argument for each theme option', async () => {
    renderHeader({ onThemeEditorClick: vi.fn() });

    for (const [label, mode] of [
      ['Dark', 'dark'],
      ['Light', 'light'],
      ['Custom', 'custom'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));
      const themeText = await screen.findByText('Theme');
      fireEvent.mouseOver(themeText);
      const option = await screen.findByText(label);
      fireEvent.click(option);
      expect(mockSetThemeMode).toHaveBeenCalledWith(mode);
      mockSetThemeMode.mockClear();
    }
  });

  it('invokes onThemeEditorClick when Edit Custom Theme is clicked', async () => {
    const onThemeEditorClick = vi.fn();
    renderHeader({ onThemeEditorClick });

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));
    const themeText = await screen.findByText('Theme');
    fireEvent.mouseOver(themeText);
    const editItem = await screen.findByText('Edit Custom Theme');
    fireEvent.click(editItem);

    expect(onThemeEditorClick).toHaveBeenCalledOnce();
  });
});
