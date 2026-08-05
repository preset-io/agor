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

describe('AppHeader Knowledge Base button', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders a standalone Knowledge Base button with correct href', () => {
    renderHeader();

    const button = screen.getByRole('link', { name: 'Knowledge Base' });
    expect(button).toHaveAttribute('href', '/ui/knowledge');
  });

  it('navigates to /knowledge via SPA navigation on plain click', () => {
    renderHeader();

    const button = screen.getByRole('link', { name: 'Knowledge Base' });
    fireEvent.click(button);

    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith('/knowledge');
  });

  it('lets modifier clicks fall through to the browser', () => {
    renderHeader();

    const button = screen.getByRole('link', { name: 'Knowledge Base' });
    button.removeAttribute('href');

    const eventWasNotCancelled = fireEvent.click(button, { metaKey: true });

    expect(eventWasNotCancelled).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('AppHeader Marketplace button', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders a promoted top-level Marketplace entry, not a gear-menu item', () => {
    renderHeader();

    const button = screen.getByRole('link', { name: 'Marketplace' });
    expect(button).toHaveAttribute('href', '/ui/marketplace');
  });

  it('shows the word without hovering — the label is why it earned a top-level slot', () => {
    renderHeader();

    // Visible text, not a tooltip or an aria-label standing in for one.
    expect(screen.getByText('Marketplace')).toBeVisible();
  });

  it('navigates to /marketplace via SPA navigation on plain click', () => {
    renderHeader();

    fireEvent.click(screen.getByRole('link', { name: 'Marketplace' }));

    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith('/marketplace');
  });

  it('lets modifier clicks fall through to the browser', () => {
    renderHeader();

    const button = screen.getByRole('link', { name: 'Marketplace' });
    button.removeAttribute('href');

    const eventWasNotCancelled = fireEvent.click(button, { metaKey: true });

    expect(eventWasNotCancelled).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('AppHeader settings dropdown', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockSetThemeMode.mockClear();
  });

  it('does not include Knowledge Base in the dropdown', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Settings menu' }));

    await screen.findByText('Settings');
    expect(screen.queryByText('Knowledge Base')).not.toBeInTheDocument();
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
