import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { MobileApp } from './MobileApp';

// Home renders deliberately over-wide AND over-tall content: the fixed shell must
// clip the width, keep the document from scrolling, and keep the nav flush.
vi.mock('../HomePage', () => ({
  HomePage: () => <div style={{ width: 2000, height: 3000 }}>too big on purpose</div>,
}));
// Keep the browser bundle light: mock the heavy routed pages / modals.
vi.mock('./SessionPage', () => ({ SessionPage: () => null }));
vi.mock('./MobileBoardPage', () => ({ MobileBoardPage: () => null }));
vi.mock('./MobileSearchPage', () => ({ MobileSearchPage: () => null }));
vi.mock('./MobileSessionsPage', () => ({ MobileSessionsPage: () => null }));
vi.mock('./MobileMarketplacePage', () => ({ MobileMarketplacePage: () => null }));
vi.mock('./MobileMoreSheet', () => ({ MobileMoreSheet: () => null }));
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

const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  await page.viewport(originalViewport.width, originalViewport.height);
});

describe('MobileApp shell is fixed to the viewport with a flush tab bar', () => {
  for (const width of [320, 360, 390, 430, 540, 600, 667, 720, 760]) {
    it(`does not overflow or scroll the document at ${width}px`, async () => {
      await page.viewport(width, 780);
      const { container, unmount } = render(
        <ThemeProvider>
          <MemoryRouter initialEntries={['/m']}>
            <Routes>
              <Route path="/m/*" element={<MobileApp client={null} {...handlers} />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      );
      const shell = container.querySelector<HTMLElement>('.ant-layout')!;
      const nav = container.querySelector<HTMLElement>('nav[aria-label="Primary"]')!;
      const doc = document.scrollingElement!;

      expect(getComputedStyle(shell).position).toBe('fixed');
      expect(shell.scrollWidth, `shell scrollWidth at ${width}px`).toBeLessThanOrEqual(width + 1);
      expect(doc.scrollHeight, 'document must not scroll').toBeLessThanOrEqual(doc.clientHeight);
      expect(nav.getBoundingClientRect().width).toBeCloseTo(width, 0);
      expect(nav.getBoundingClientRect().bottom).toBeCloseTo(window.innerHeight, 0);

      // Scrolling the page content (and trying the document) never lifts the bar.
      const content = nav.previousElementSibling as HTMLElement;
      content.scrollTop = 2000;
      doc.scrollTop = 500;
      expect(content.scrollTop).toBeGreaterThan(0);
      expect(shell.scrollTop).toBe(0);
      expect(nav.getBoundingClientRect().bottom).toBeCloseTo(window.innerHeight, 0);

      for (const name of ['Home', 'Board', 'Marketplace', 'More', 'Ask your primary assistant']) {
        const el = container.querySelector<HTMLElement>(`[aria-label="${name}"]`);
        expect(el, `${name} missing at ${width}px`).toBeTruthy();
        expect(
          el!.getBoundingClientRect().right,
          `${name} clipped at ${width}px`
        ).toBeLessThanOrEqual(width + 1);
      }
      unmount();
    });
  }
});
