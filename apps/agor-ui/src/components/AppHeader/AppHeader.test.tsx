import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader';

const mockNavigate = vi.hoisted(() => vi.fn());

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
vi.mock('../ThemeSwitcher', () => ({
  ThemeSwitcher: () => <div data-testid="theme-switcher" />,
}));
vi.mock('./GlobalPresenceFacepile', () => ({
  GlobalPresenceFacepile: () => <div data-testid="presence-facepile" />,
}));

function renderHeader() {
  return render(
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <AppHeader />
    </MemoryRouter>
  );
}

describe('AppHeader Knowledge link', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders a basename-aware href for modified clicks and new tabs', () => {
    renderHeader();

    expect(screen.getByRole('link', { name: 'Knowledge' })).toHaveAttribute(
      'href',
      '/ui/knowledge'
    );
  });

  it('uses SPA navigation and prevents default for plain left clicks', () => {
    renderHeader();

    const eventWasNotCancelled = fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }));

    expect(eventWasNotCancelled).toBe(false);
    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith('/knowledge');
  });

  it('lets modified clicks fall through to the browser', () => {
    renderHeader();

    const knowledgeLink = screen.getByRole('link', { name: 'Knowledge' });
    // Remove the href after locating the link so jsdom does not attempt real navigation.
    // This still exercises the click handler's modified-click behavior.
    knowledgeLink.removeAttribute('href');

    const eventWasNotCancelled = fireEvent.click(knowledgeLink, { metaKey: true });

    expect(eventWasNotCancelled).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
