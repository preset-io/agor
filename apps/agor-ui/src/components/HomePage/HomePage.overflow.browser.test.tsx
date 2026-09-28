import type { Board, BoardComment, Branch, Session, User } from '@agor-live/client';
import { cleanup, render, screen, within } from '@testing-library/react';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { buildSessionMaps, EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { HomePage } from './HomePage';

afterEach(cleanup);

const ME = 'u1';
const LONG = 'Investigate the intermittently failing deployment pipeline on the staging cluster';
const now = Date.now();
const session = (id: string, extra: Partial<Session>) =>
  ({
    session_id: id,
    title: `${LONG} ${id}`,
    status: 'idle',
    archived: false,
    created_by: ME,
    branch_id: 'b1',
    genealogy: { children: [] },
    scheduled_from_branch: false,
    ready_for_prompt: false,
    agentic_tool: 'claude-code',
    last_updated: new Date(now - 60_000).toISOString(),
    ...extra,
  }) as unknown as Session;

const teammate = (id: string, name: string) =>
  ({
    branch_id: id,
    name: id,
    board_id: 'board-tm',
    created_by: 'u2',
    archived: false,
    custom_context: { teammate: { kind: 'teammate', displayName: name, emoji: '🦖' } },
  }) as unknown as Branch;

function seed() {
  agorStore.setState({
    ...EMPTY_MAPS,
    ...buildSessionMaps([
      session('perm', { status: 'awaiting_permission' }),
      session('perm2', { status: 'awaiting_permission' }),
      session('done', { ready_for_prompt: true }),
      session('done2', { ready_for_prompt: true, branch_id: 'b1' }),
      session('fail', { status: 'failed', branch_id: 'b2' }),
      session('fail2', { status: 'failed', branch_id: 'b1' }),
      session('run', { status: 'running', scheduled_from_branch: true }),
      session('idle', {}),
    ]),
    commentById: new Map(
      ['c1', 'c2', 'c3'].map((id) => [
        id,
        {
          comment_id: id,
          board_id: 'board1',
          branch_id: 'b1',
          created_by: 'u2',
          content: `@"Ada Lovelace" ${LONG}`,
          resolved: false,
          created_at: new Date(now).toISOString(),
        } as unknown as BoardComment,
      ])
    ),
    branchById: new Map([
      [
        'b1',
        {
          branch_id: 'b1',
          name: 'feature-some-really-long-branch-name-here',
          board_id: 'board1',
        } as Branch,
      ],
      [
        'b2',
        { branch_id: 'b2', name: 'fix-another-long-branch-name', board_id: 'board1' } as Branch,
      ],
      ['tm1', teammate('tm1', 'An assistant with a very long display name')],
      ['tm2', teammate('tm2', 'Rexy')],
    ]),
    boardById: new Map([
      [
        'board1',
        {
          board_id: 'board1',
          name: 'A board with a long enough name to matter',
          archived: false,
        } as Board,
      ],
      [
        'board-tm',
        { board_id: 'board-tm', name: 'Team', archived: false, description: LONG } as Board,
      ],
    ]),
    userById: new Map([
      [ME, { user_id: ME, name: 'Ada Lovelace' } as User],
      ['u2', { user_id: 'u2', name: 'Grace Hopper' } as User],
    ]),
    sessionsHydrated: true,
    branchesHydrated: true,
  } as never);
}

async function renderHomeAt(width: number, dark: boolean) {
  await page.viewport(width, 900);
  seed();
  render(
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { motion: false },
      }}
    >
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <AntApp>
          <MemoryRouter>
            <div data-testid="viewport" style={{ width: '100vw', height: '100vh' }}>
              <HomePage
                client={null}
                currentUser={{ user_id: ME, name: 'Ada Lovelace', role: 'member' } as User}
                recentBoardIds={['board1', 'board-tm']}
                onBoardClick={vi.fn()}
                onBranchClick={vi.fn()}
                onSessionClick={vi.fn()}
                onCreateSession={vi.fn()}
              />
            </div>
          </MemoryRouter>
        </AntApp>
      </ConnectionProvider>
    </ConfigProvider>
  );
  await screen.findByRole('heading', { name: 'Knowledge' });
  await screen.findByText('Rexy');
  return screen.getByTestId('viewport');
}

// True horizontal overflow: content wider than its box where the box does not clip.
const scrollingNodes = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('*'))
    .filter(
      (el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'hidden'
    )
    .map(
      (el) =>
        `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`
    );

// Hit areas: a Segmented or affixed input is tapped on its outer box.
const TAPPABLE =
  'button, [role="button"]:not(.ant-input-clear-icon), .ant-segmented, .ant-input-affix-wrapper, .ant-input-search';

describe('HomePage horizontal fit and touch targets', () => {
  for (const width of [360, 390, 430, 768, 1023, 1440]) {
    for (const dark of [false, true]) {
      it(`fits at ${width}px (${dark ? 'dark' : 'light'})`, async () => {
        const viewport = await renderHomeAt(width, dark);
        const bad = scrollingNodes(viewport);
        expect(bad, `scroll overflow at ${width}px:\n${bad.join('\n')}`).toEqual([]);

        const wide = Array.from(
          viewport.querySelectorAll<HTMLElement>('section, .ant-card, button')
        )
          .filter((el) => el.getBoundingClientRect().right > width + 1)
          .map((el) => `${el.tagName.toLowerCase()} "${el.textContent?.slice(0, 30)}"`);
        expect(wide, `past the right edge at ${width}px:\n${wide.join('\n')}`).toEqual([]);

        const toolbar = viewport.querySelector<HTMLElement>('[data-home-toolbar]');
        const tops = new Set(
          Array.from(toolbar?.children ?? []).map((el) =>
            Math.round(el.getBoundingClientRect().top)
          )
        );
        expect(tops.size, `My work toolbar wraps at ${width}px`).toBe(1);
        // View sits in the toolbar where it fits, and in the Filters sheet on phones.
        const view = toolbar?.querySelector<HTMLElement>('.ant-select');
        if (width < 768) expect(view, `View in the toolbar at ${width}px`).toBeNull();
        else expect(view?.getBoundingClientRect().height).toBe(32);

        // Ask box toolbar: every control one height, 44px on phones and 32px otherwise.
        const ask = viewport.querySelector<HTMLElement>('[data-home-ask-toolbar]');
        const askHeights = new Set(
          Array.from(ask?.querySelectorAll<HTMLElement>('button, .ant-select') ?? []).map((el) =>
            Math.round(el.getBoundingClientRect().height)
          )
        );
        expect([...askHeights], `ask box control heights at ${width}px`).toEqual([
          width < 768 ? MOBILE_TOUCH_TARGET : 32,
        ]);

        // The Needs you toggle: row-aligned, one line, and its count never truncates.
        const toggle = within(viewport).getByRole('button', { name: /^\d+ more · / });
        const count = within(toggle).getByText(/^\d+ more$/);
        expect(count.getBoundingClientRect().right).toBeLessThanOrEqual(width);
        const rowText = toggle
          .closest('section')
          ?.querySelector('[data-home-row] .ant-typography')
          ?.getBoundingClientRect().left;
        expect(Math.abs(count.getBoundingClientRect().left - (rowText ?? 0))).toBeLessThan(1);
        expect(toggle.getBoundingClientRect().height).toBe(width < 768 ? MOBILE_TOUCH_TARGET : 24);

        // Every Needs you row kind shares one right-aligned time column.
        const needs = toggle.closest('section') as HTMLElement;
        const rights = new Set(
          Array.from(needs.querySelectorAll<HTMLElement>('.agor-home-time')).map((el) =>
            Math.round(el.getBoundingClientRect().right)
          )
        );
        expect(rights.size, `Needs you times out of line at ${width}px`).toBe(1);

        if (width < 768) {
          const small = Array.from(viewport.querySelectorAll<HTMLElement>(TAPPABLE))
            .filter(
              (el) =>
                el.offsetParent &&
                getComputedStyle(el).visibility !== 'hidden' &&
                el.getBoundingClientRect().height < MOBILE_TOUCH_TARGET - 0.5
            )
            .map(
              (el) =>
                `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').slice(0, 30)}" ${el.getBoundingClientRect().height.toFixed(0)}px`
            );
          expect(small, `tap targets under 44px at ${width}px:\n${small.join('\n')}`).toEqual([]);
        }
      });
    }
  }
});
