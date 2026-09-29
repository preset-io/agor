import type { Board } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
