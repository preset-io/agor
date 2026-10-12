import type { Board } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';
import '../../index.css';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import { BoardTeammatePanel } from './BoardTeammatePanel';

checkBrowserSanity();

const board = { board_id: 'board-1', name: 'Board' } as Board;

beforeEach(() => agorStore.setState({ ...EMPTY_MAPS }));
afterEach(cleanup);

function contains(outer: DOMRect, inner: DOMRect) {
  return (
    inner.left >= outer.left - 0.5 &&
    inner.right <= outer.right + 0.5 &&
    inner.top >= outer.top - 0.5 &&
    inner.bottom <= outer.bottom + 0.5
  );
}

it.each([1, 12])(
  'keeps all tabs and a %i unread counter unclipped at the 320px minimum',
  async (count) => {
    render(
      <App>
        <div style={{ height: 600, width: 320 }}>
          <BoardTeammatePanel
            board={board}
            activeTab="all-sessions"
            primaryTeammateInaccessible={false}
            unreadCommentsCount={count}
            onSessionClick={vi.fn()}
            onCollapse={vi.fn()}
            client={null}
          />
        </div>
      </App>
    );

    const counter = await screen.findByTitle(String(count));
    // The tab list's scroll viewport is what clips; antd exposes no role for it.
    const viewport = counter.closest('.ant-tabs-nav-wrap')!.getBoundingClientRect();
    expect(contains(viewport, counter.getBoundingClientRect())).toBe(true);
    for (const tab of screen.getAllByRole('tab')) {
      expect(contains(viewport, tab.getBoundingClientRect())).toBe(true);
    }
  }
);

it('shows the edge fade and scrolls when the tabs overflow by only a few pixels', async () => {
  const panel = (width: number) => (
    <App>
      <div style={{ height: 600, width }}>
        <BoardTeammatePanel
          board={board}
          activeTab="all-sessions"
          primaryTeammateInaccessible={false}
          unreadCommentsCount={12}
          onSessionClick={vi.fn()}
          onCollapse={vi.fn()}
          client={null}
        />
      </div>
    </App>
  );
  const { rerender } = render(panel(600));
  const counter = await screen.findByTitle('12');
  const viewport = counter.closest<HTMLElement>('.ant-tabs-nav-wrap')!;
  const list = viewport.firstElementChild as HTMLElement;
  const bar = viewport.parentElement!;
  // Everything in the bar that is not the tab list, plus the panel's 1px border.
  const chrome = bar.getBoundingClientRect().width - viewport.getBoundingClientRect().width + 1;

  rerender(panel(Math.ceil(chrome + list.scrollWidth) - 6));

  await waitFor(() => expect(viewport).toHaveClass('ant-tabs-nav-wrap-ping-right'));
  expect(contains(viewport.getBoundingClientRect(), counter.getBoundingClientRect())).toBe(false);
  fireEvent.wheel(viewport, { deltaX: 50 });
  await waitFor(() =>
    expect(contains(viewport.getBoundingClientRect(), counter.getBoundingClientRect())).toBe(true)
  );
  expect(viewport).toHaveClass('ant-tabs-nav-wrap-ping-left');
});

it.each(['light', 'dark'])(
  'keeps overflowing 99+ tabs reachable without the menu (%s)',
  async (mode) => {
    render(
      <ConfigProvider
        theme={{ algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}
      >
        <App>
          <div style={{ height: 600, width: 320 }}>
            <BoardTeammatePanel
              board={board}
              primaryTeammateInaccessible={false}
              unreadCommentsCount={100}
              onSessionClick={vi.fn()}
              onCollapse={vi.fn()}
              client={null}
            />
          </div>
        </App>
      </ConfigProvider>
    );
    const counter = await screen.findByTitle('100');
    expect(counter).toHaveTextContent('99+');
    const viewport = counter.closest<HTMLElement>('.ant-tabs-nav-wrap')!;
    const operations = viewport.parentElement!.querySelector('.ant-tabs-nav-operations')!;
    expect(getComputedStyle(operations).display).toBe('none');
    // 99+ can fit at 320px with some system fonts. Force a small overflow as well.
    const list = viewport.firstElementChild as HTMLElement;
    const bar = viewport.parentElement!;
    const chrome = bar.getBoundingClientRect().width - viewport.getBoundingClientRect().width + 1;
    const panel = viewport.closest('.agor-panel-tabs')!.parentElement!.parentElement!;
    panel.style.width = `${Math.min(320, Math.ceil(chrome + list.scrollWidth) - 6)}px`;
    await waitFor(() => expect(viewport).toHaveClass('ant-tabs-nav-wrap-ping-right'));

    // Real wheel input, not a React event handler invocation.
    await userEvent.hover(screen.getByRole('tab', { name: /Sessions$/ }));
    await cdp().send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 120,
      y: viewport.getBoundingClientRect().top + 16,
      deltaX: 100,
      deltaY: 0,
    });
    await waitFor(() =>
      expect(contains(viewport.getBoundingClientRect(), counter.getBoundingClientRect())).toBe(true)
    );

    // The hidden overflow menu must not remove the keyboard route to Comments.
    const teammate = screen.getByRole('tab', { name: /Teammate$/ });
    await userEvent.click(teammate);
    await userEvent.keyboard('{End}{Enter}');
    const comments = screen.getByRole('tab', { name: /Comments/ });
    expect(comments).toHaveAttribute('aria-selected', 'true');
    await waitFor(() =>
      expect(contains(viewport.getBoundingClientRect(), counter.getBoundingClientRect())).toBe(true)
    );
    await userEvent.keyboard('{Home}{Enter}');
    expect(teammate).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowRight}{Enter}');
    expect(screen.getByRole('tab', { name: /Sessions$/ })).toHaveAttribute('aria-selected', 'true');

    // Swipe left to expose the end of the strip, even without a visible menu.
    const rect = viewport.getBoundingClientRect();
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp().send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: rect.left + 160, y: rect.top + 16 }],
    });
    await cdp().send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: rect.left + 40, y: rect.top + 16 }],
    });
    await cdp().send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitFor(() =>
      expect(contains(viewport.getBoundingClientRect(), counter.getBoundingClientRect())).toBe(true)
    );
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
);

it('keeps the full Comments text reachable after the unread count clears at a larger type scale', async () => {
  const panel = (count: number) => (
    <ConfigProvider theme={{ token: { fontSizeSM: 16 } }}>
      <App>
        <div style={{ height: 600, width: 320 }}>
          <BoardTeammatePanel
            board={board}
            primaryTeammateInaccessible={false}
            unreadCommentsCount={count}
            onSessionClick={vi.fn()}
            onCollapse={vi.fn()}
            client={null}
          />
        </div>
      </App>
    </ConfigProvider>
  );
  const { rerender } = render(panel(12));
  await screen.findByTitle('12');
  rerender(panel(0));
  const comments = screen.getByRole('tab', { name: /Comments/ });
  const viewport = comments.closest('.ant-tabs-nav-wrap')!;
  await userEvent.click(screen.getByRole('tab', { name: /Sessions$/ }));
  await userEvent.keyboard('{End}{Enter}');
  expect(comments).toHaveAttribute('aria-selected', 'true');
  const text = within(comments).getByText('Comments');
  const range = document.createRange();
  range.selectNodeContents(text.firstChild!);
  await waitFor(() =>
    expect(contains(viewport.getBoundingClientRect(), range.getBoundingClientRect())).toBe(true)
  );
});
