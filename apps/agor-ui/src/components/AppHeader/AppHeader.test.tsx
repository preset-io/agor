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

  it('navigates to Knowledge via SPA navigation from the dropdown', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const knowledgeItem = await screen.findByText('Knowledge');
    fireEvent.click(knowledgeItem);

    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith('/knowledge');
  });

  it('renders Knowledge as a basename-aware link for modified clicks and new tabs', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const knowledgeLink = await screen.findByRole('link', { name: 'Knowledge' });
    expect(knowledgeLink).toHaveAttribute('href', '/ui/knowledge');
  });

  it('lets modified clicks on Knowledge fall through to the browser', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const knowledgeLink = await screen.findByRole('link', { name: 'Knowledge' });
    knowledgeLink.removeAttribute('href');

    const eventWasNotCancelled = fireEvent.click(knowledgeLink, { metaKey: true });

    expect(eventWasNotCancelled).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('invokes onEventStreamClick when Live Events is clicked', async () => {
    const onEventStreamClick = vi.fn();
    renderHeader({ eventStreamEnabled: true, onEventStreamClick });

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    const liveEventsItem = await screen.findByText('Live Events');
    fireEvent.click(liveEventsItem);

    expect(onEventStreamClick).toHaveBeenCalledOnce();
  });

  it('invokes onSettingsClick when Settings is clicked', async () => {
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
