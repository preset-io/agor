import type { Session, User } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import { MOBILE_SHELL_MAX_WIDTH } from '../../utils/deviceDetection';
import SessionPanel from './SessionPanel';

// Keep the real header and responsive shell; the transcript/composer are unrelated.
vi.mock('./SessionPanelContent', () => ({ SessionPanelContent: () => null }));
vi.mock('./SessionFooter', () => ({ SessionFooter: () => null }));
vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({ ForkSpawnModal: () => null }));

checkBrowserSanity();
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  cleanup();
  agorStore.setState({ userById: new Map() });
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each(['light', 'dark'])(
  'bounds creator attribution and preserves header actions (%s)',
  async (mode) => {
    if (originalViewport.width > 320) await page.viewport(1440, 900);
    const creator = {
      user_id: 'creator',
      name: 'Averylongunbrokencreatordisplaynamethatmustnotcoverheaderactions'.repeat(2),
    } as User;
    const session = {
      session_id: 'session-1',
      agentic_tool: 'codex',
      title: 'Review panel headers',
      status: 'awaiting_permission',
      created_by: creator.user_id,
    } as unknown as Session;
    const onUpdateSession = vi.fn();
    const onClose = vi.fn();
    agorStore.setState({ userById: new Map([[creator.user_id, creator]]) });
    render(
      <ConfigProvider
        theme={{ algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}
      >
        <App>
          <AppActionsProvider value={{ onUpdateSession }}>
            <div style={{ width: Math.min(window.innerWidth, 480), height: 600 }}>
              <SessionPanel client={null} session={session} open onClose={onClose} />
            </div>
          </AppActionsProvider>
        </App>
      </ConfigProvider>
    );

    expect(screen.getByText('Awaiting permission')).toBeVisible();
    const name = screen.getByText(creator.name!);
    expect(name.parentElement!.querySelector('.ant-avatar')!.getBoundingClientRect().width).toBe(
      16
    );
    const more = screen.getByRole('button', { name: 'More actions' });
    await waitFor(() => {
      expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(
        more.getBoundingClientRect().left
      );
    });
    await userEvent.hover(name);
    await waitFor(() => expect(screen.getByText(`Created by ${creator.name}`)).toBeVisible());

    await userEvent.click(screen.getByRole('button', { name: /Review panel headers/ }));
    const input = screen.getByPlaceholderText('Untitled session');
    expect(getComputedStyle(input).fontSize).toBe('16px');
    await userEvent.fill(input, 'Renamed session');
    await userEvent.keyboard('{Enter}');
    expect(onUpdateSession).toHaveBeenCalledWith(session.session_id, { title: 'Renamed session' });

    const mobile = window.innerWidth < MOBILE_SHELL_MAX_WIDTH;
    const close = screen.getByRole('button', {
      name: mobile ? 'Close' : 'Close panel',
    });
    const search = screen.getByRole('button', { name: 'Search session' });
    if (mobile) {
      for (const button of [close, more, search]) {
        expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
        expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
    }
    await userEvent.click(search);
    expect(screen.getByPlaceholderText('Search session...')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  }
);
