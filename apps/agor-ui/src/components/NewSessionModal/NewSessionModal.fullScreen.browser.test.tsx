import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { __resetAuthConfigForTests, __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { agorStore } from '../../store/agorStore';
import { NewSessionModal } from './NewSessionModal';

const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  cleanup();
  agorStore.setState({ agenticToolSettingsHydrated: false });
  __resetAuthConfigForTests();
  await page.viewport(originalViewport.width, originalViewport.height);
});

function onScreen(element: Element) {
  const box = element.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
}

// The mobile shell's new-session step: the desktop dialog, edge to edge on a phone.
describe('NewSessionModal full screen', () => {
  for (const [width, height] of [
    [375, 667],
    [320, 568],
  ]) {
    it(`fits the agent, configuration and Create at ${width}x${height}`, async () => {
      await page.viewport(width, height);
      __setAuthConfigForTests({ requireAuth: false });
      agorStore.setState({ agenticToolSettingsHydrated: true });
      render(
        <ConfigProvider theme={{ token: { motion: false } }}>
          <App>
            <NewSessionModal
              open
              fullScreen
              branchId="branch-1"
              availableAgents={[
                { id: 'claude-code', name: 'Claude Code', icon: '🤖' },
                { id: 'codex', name: 'Codex', icon: '💻' },
              ]}
              client={null}
              onClose={vi.fn()}
              onCreate={vi.fn(async () => null)}
            />
          </App>
        </ConfigProvider>
      );

      const dialog = await screen.findByRole('dialog');
      const container = dialog.closest('.ant-modal-container') ?? dialog;
      await waitFor(() => {
        const box = container.getBoundingClientRect();
        expect(box.left).toBeLessThanOrEqual(1);
        expect(box.width).toBeGreaterThanOrEqual(window.innerWidth - 1);
      });
      // No sideways scrolling: the agent tiles and config chips wrap within the screen.
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      onScreen(screen.getByText('Configuration'));
      onScreen(screen.getByTestId('model-chip'));

      // The footer stays pinned while the body scrolls, so Create is always reachable.
      onScreen(screen.getByRole('button', { name: 'Create Session' }));
    });
  }
});
