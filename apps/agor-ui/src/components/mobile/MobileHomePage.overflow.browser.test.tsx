import type { Board, Branch, Session } from '@agor-live/client';
import { cleanup, render } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { MobileHomePage } from './MobileHomePage';

afterEach(cleanup);

const sessionById = new Map<string, Session>([
  [
    's1',
    {
      session_id: 's1',
      title:
        'A fairly long session title that should ellipsize rather than push the status pill off',
      status: 'failed',
      created_by: 'u1',
      last_updated: '2026-01-01',
      model_config: { model: 'claude-opus-4-8' },
      branch_id: 'b1',
    } as Session,
  ],
]);
const branchById = new Map<string, Branch>([
  [
    'b1',
    {
      branch_id: 'b1',
      name: 'feature-some-really-long-branch-name-here',
      board_id: 'board1',
    } as Branch,
  ],
]);
const boardById = new Map<string, Board>([
  ['board1', { board_id: 'board1', name: 'A board with a long enough name to matter' } as Board],
]);

// True horizontal overflow = an element whose content is wider than its box AND
// whose computed overflow-x is not `hidden` (a `hidden` box clips decoration
// like the glass highlight bubble, which getBoundingClientRect reports pre-clip).
function scrollingNodes(root: HTMLElement): string[] {
  const bad: string[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (getComputedStyle(el).overflowX === 'hidden') continue;
    bad.push(
      `${el.tagName.toLowerCase()}.${el.className?.toString().slice(0, 30)} scrollW=${el.scrollWidth} clientW=${el.clientWidth}`
    );
  }
  return bad;
}

// Mimic the shell: a fixed-size flex column, NOT an overflow:hidden clip.
function renderHomeAt(width: number): HTMLElement {
  const { container } = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter>
        <div
          style={{ width, height: 800, display: 'flex', flexDirection: 'column' }}
          data-testid="viewport"
        >
          <MobileHomePage
            sessionById={sessionById}
            branchById={branchById}
            boardById={boardById}
            currentUser={{ user_id: 'u1', name: 'Ada Lovelace' } as never}
            onAsk={vi.fn()}
            primaryTeammateName="Fable"
            primaryTeammateEmoji="🤖"
          />
        </div>
      </MemoryRouter>
    </ConfigProvider>
  );
  return container.querySelector<HTMLElement>('[data-testid="viewport"]')!;
}

describe('MobileHomePage horizontal fit', () => {
  for (const width of [360, 390, 430, 540, 640, 667, 720, 760, 820]) {
    it(`does not overflow at ${width}px`, () => {
      agorStore.getState().reset();
      // Seed an awaiting session so the reused desktop JumpBackInSection renders.
      agorStore.setState({
        sessionById: new Map<string, Session>([
          [
            'await1',
            {
              session_id: 'await1',
              title:
                'Investigate the intermittently failing deployment pipeline on the staging cluster',
              status: 'awaiting_input',
              created_by: 'u1',
              last_updated: '2026-01-02',
            } as Session,
          ],
        ]),
      } as never);
      const viewport = renderHomeAt(width);
      const bad = scrollingNodes(viewport);
      expect(bad, `scroll overflow at ${width}px:\n${bad.join('\n')}`).toEqual([]);

      // The user's acceptance check: no card extends past the viewport's right
      // edge (guards against a genuinely too-wide card that overflow-x:hidden
      // would otherwise silently clip).
      const limit = viewport.getBoundingClientRect().right;
      const wideCards = Array.from(viewport.querySelectorAll<HTMLElement>('.ant-card'))
        .filter((el) => el.getBoundingClientRect().right > limit + 1)
        .map((el) => `card right=${el.getBoundingClientRect().right.toFixed(1)} > ${limit}`);
      expect(wideCards, `card overflow at ${width}px:\n${wideCards.join('\n')}`).toEqual([]);
    });
  }

  const spread = (vals: number[]) => Math.max(...vals) - Math.min(...vals);

  for (const width of [360, 390, 430]) {
    it(`aligns every card's content to one left edge at ${width}px`, () => {
      agorStore.getState().reset();
      const viewport = renderHomeAt(width);
      const cards = Array.from(viewport.querySelectorAll<HTMLElement>('.ant-card'));
      expect(cards.length).toBeGreaterThan(1);

      // Every card sits at the single outer gutter (no card adds its own margin).
      expect(spread(cards.map((c) => c.getBoundingClientRect().left))).toBeLessThanOrEqual(1);

      // One inner padding across every card header + body (no 0/12/16 mix).
      const insets = [
        ...viewport.querySelectorAll<HTMLElement>('.ant-card-head'),
        ...viewport.querySelectorAll<HTMLElement>('.ant-card-body'),
      ].map((el) => Number.parseFloat(getComputedStyle(el).paddingLeft));
      expect(spread(insets)).toBeLessThanOrEqual(0.5);

      // Titles and rows (session + board list content) share one vertical edge,
      // including the nested list content (no double gutter).
      const contentLefts = [
        ...viewport.querySelectorAll<HTMLElement>('.ant-card-head-title'),
        ...viewport.querySelectorAll<HTMLElement>('.ant-list-item-meta'),
      ].map((el) => el.getBoundingClientRect().left);
      expect(contentLefts.length).toBeGreaterThan(2);
      expect(spread(contentLefts)).toBeLessThanOrEqual(1);
    });
  }
});
