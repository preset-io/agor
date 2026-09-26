import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { MobileApp } from './MobileApp';

// Home renders a deliberately over-wide child; the shell root must clip it so
// it can never widen the document and drag the in-flow bottom nav off-screen.
vi.mock('./MobileHomePage', () => ({
  MobileHomePage: () => <div style={{ width: 2000, height: 200 }}>too wide on purpose</div>,
}));
// Keep the browser bundle light: mock the heavy routed pages / modals.
vi.mock('./SessionPage', () => ({ SessionPage: () => null }));
vi.mock('./MobileBoardPage', () => ({ MobileBoardPage: () => null }));
vi.mock('./MobileCommentsPage', () => ({ MobileCommentsPage: () => null }));
vi.mock('./MobileSearchPage', () => ({ MobileSearchPage: () => null }));
vi.mock('./MobileSessionsPage', () => ({ MobileSessionsPage: () => null }));
vi.mock('./MobileMarketplacePage', () => ({ MobileMarketplacePage: () => null }));
vi.mock('./MobileMoreSheet', () => ({ MobileMoreSheet: () => null }));
vi.mock('./MobileNavTree', () => ({ MobileNavTree: () => null }));
vi.mock('../BranchModal', () => ({ BranchModal: () => null }));
vi.mock('../SettingsModal/PrimaryTeammatePicker', () => ({ PrimaryTeammatePicker: () => null }));
vi.mock('../AgentSelectionGrid', () => ({
  AgentSelectionGrid: () => null,
  AVAILABLE_AGENTS: [],
}));

const handlers = {
  authGeneration: 0,
  onCreateSession: vi.fn(async () => null),
  onForkSession: vi.fn(async () => {}),
  onBtwForkSession: vi.fn(async () => {}),
  onSpawnSession: vi.fn(async () => {}),
  onUpdateSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onSendComment: vi.fn(),
  onOpenWorkspaceSettings: vi.fn(),
  onOpenUserSettings: vi.fn(),
};

describe('MobileApp shell clips over-wide content and keeps the nav', () => {
  for (const width of [320, 360, 390, 430, 540, 600, 667, 720, 760]) {
    it(`does not overflow the viewport at ${width}px`, () => {
      const { container, unmount } = render(
        <ThemeProvider>
          <MemoryRouter initialEntries={['/m']}>
            <Routes>
              <Route
                path="/m/*"
                element={
                  <div
                    style={{ width, height: 780, boxSizing: 'border-box', overflow: 'visible' }}
                    data-testid="vp"
                  >
                    <MobileApp client={null} {...handlers} />
                  </div>
                }
              />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      );
      const vp = container.querySelector<HTMLElement>('[data-testid="vp"]')!;
      const shell = vp.firstElementChild as HTMLElement;

      // The shell (and thus the document) never grows past the viewport width.
      expect(shell.scrollWidth, `shell scrollWidth at ${width}px`).toBeLessThanOrEqual(width + 1);

      // All five destinations plus the Ask FAB are present and within the viewport.
      const limit = vp.getBoundingClientRect().right;
      for (const name of ['Home', 'Board', 'Marketplace', 'More', 'Ask your primary assistant']) {
        const el = vp.querySelector<HTMLElement>(`[aria-label="${name}"]`);
        expect(el, `${name} missing at ${width}px`).toBeTruthy();
        expect(
          el!.getBoundingClientRect().right,
          `${name} clipped at ${width}px`
        ).toBeLessThanOrEqual(limit + 1);
      }
      unmount();
    });
  }
});
