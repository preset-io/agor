import type { Board, BoardComment } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { MobileBoardPage } from './MobileBoardPage';

vi.mock('../SessionCanvas/SessionCanvas', () => ({ default: () => null }));

const board = { board_id: 'board-1', name: 'Delivery', objects: {} } as unknown as Board;
const comment = {
  comment_id: 'c1',
  board_id: 'board-1',
  content: 'Look',
  resolved: false,
} as unknown as BoardComment;
const originalViewport = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  cleanup();
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each([360, 390, 430])('keeps the board tabs on one touch-size row at %ipx', async (width) => {
  await page.viewport(width, 760);
  // An unread badge widens Comments, the tightest case.
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([[board.board_id, board]]),
    commentById: new Map([[comment.comment_id, comment]]),
  } as never);
  render(
    <App>
      <MemoryRouter initialEntries={['/m/board/board-1']}>
        <Routes>
          <Route
            path="/m/board/:boardId"
            element={
              <div style={{ height: 760, display: 'flex', flexDirection: 'column' }}>
                <MobileBoardPage
                  client={null}
                  boardById={agorStore.getState().boardById}
                  branchById={new Map()}
                  onOpenBranch={vi.fn()}
                  onNewSession={vi.fn()}
                  onForkSession={vi.fn(async () => {})}
                  onSpawnSession={vi.fn(async () => {})}
                  onSendComment={vi.fn()}
                />
              </div>
            }
          />
        </Routes>
      </MemoryRouter>
    </App>
  );

  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((tab) => tab.textContent?.replace(/\d+$/, ''))).toEqual([
    'Board',
    'Teammate',
    'Sessions',
    'Comments',
  ]);
  const rects = tabs.map((tab) => tab.closest('.ant-tabs-tab')!.getBoundingClientRect());
  for (const rect of rects) {
    expect(rect.top).toBeCloseTo(rects[0].top, 0);
    expect(rect.height).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET);
    expect(rect.right).toBeLessThanOrEqual(width);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  // The unread badge sits clear of the label, not over its last letter.
  const badge = screen.getByTitle('1').getBoundingClientRect();
  const labelText = [...tabs[3].querySelectorAll('span')]
    .flatMap((span) => [...span.childNodes])
    .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent === 'Comments')!;
  const label = document.createRange();
  label.selectNodeContents(labelText);
  expect(badge.left).toBeGreaterThan(label.getBoundingClientRect().right);
});
