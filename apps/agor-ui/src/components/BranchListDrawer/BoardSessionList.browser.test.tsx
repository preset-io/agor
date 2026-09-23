import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../index.css';
import { BoardSessionList } from './BranchListDrawer';

// biome-ignore lint/plugin/noHardcodedColorLiteral: browser-computed transparency sentinel, not a UI palette
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const config = { algorithm: theme.darkAlgorithm, token: { motion: false } };
const token = theme.getDesignToken(config);

const board = { board_id: 'board-1', name: 'Demo' } as Board;
const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;
const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  repo_id: 'repo-1',
  name: 'feature/teams-gateway',
} as Branch;

function makeSession(id: string, title: string, overrides: Partial<Session> = {}): Session {
  return {
    session_id: id,
    branch_id: branch.branch_id,
    title,
    description: '',
    agentic_tool: 'codex',
    status: 'idle',
    archived: false,
    ready_for_prompt: false,
    created_at: '2026-09-01T00:00:00.000Z',
    last_updated: new Date(Date.now() - 5 * 60_000).toISOString(),
    genealogy: { children: [] },
    ...overrides,
  } as Session;
}

const sessions = [
  makeSession('read', 'Resync Teams gateway with advanced main'),
  makeSession('ready', 'Final independent Teams PostgreSQL QA', { ready_for_prompt: true }),
  makeSession('waiting', 'Independent PostgreSQL QA for Teams gateway', {
    status: 'awaiting_permission',
  }),
  makeSession('running', 'Implement Teams gateway retries', { status: 'running' }),
  makeSession('failed', 'Remediate Teams authority blockers', {
    status: 'failed',
    description: 'Snapshot migrations broke the authority check',
  }),
];

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function mount() {
  const onSessionClick = vi.fn();
  render(
    <ConfigProvider theme={config}>
      <App style={{ background: token.colorBgContainer, height: 600 }}>
        <div style={{ width: 420, height: 600 }}>
          <BoardSessionList
            board={board}
            currentBoardId={board.board_id}
            branchById={new Map([[branch.branch_id, branch]])}
            repoById={new Map([[repo.repo_id, repo]])}
            sessionsByBranch={new Map([[branch.branch_id, sessions]])}
            onSessionClick={onSessionClick}
          />
        </div>
      </App>
    </ConfigProvider>
  );
  return { onSessionClick };
}

const row = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`^Open session ${title}`) });

it('follows the teammate panel row grammar', async () => {
  mount();

  for (const session of sessions) {
    const element = row(session.title!);
    expect(element.getBoundingClientRect().height).toBeCloseTo(token.controlHeight, 0);
    // Borderless logo, no pill: the branch is quiet inline metadata.
    expect(getComputedStyle(element.querySelector('.tool-icon')!).borderTopWidth).toBe('0px');
    expect(element.querySelector('.ant-tag')).toBeNull();
    expect(within(element).getByText('feature/teams-gateway')).toBeVisible();
  }
  // Rows sit flush in whatever order the list sorts them.
  const tops = sessions
    .map((session) => row(session.title!).getBoundingClientRect().top)
    .sort((a, b) => a - b);
  for (let index = 1; index < tops.length; index += 1) {
    expect(tops[index]! - tops[index - 1]!).toBeCloseTo(token.controlHeight, 0);
  }

  // Status marks and names match the panel's.
  expect(
    within(row('Final independent')).getByRole('img', { name: 'Ready for prompt' })
  ).toBeVisible();
  expect(
    within(row('Independent PostgreSQL QA')).getByRole('img', { name: 'Awaiting permission' })
  ).toHaveClass('status-dot-run');
  expect(row('Independent PostgreSQL QA')).toHaveAccessibleName(/; awaiting permission$/);
  // Running is a spinner, centered on the row like the dots.
  const spinner = within(row('Implement Teams')).getByRole('img', { name: 'Running' });
  expect(spinner).toHaveClass('anticon-spin');
  const middle = (rect: DOMRect) => rect.top + rect.height / 2;
  expect(
    Math.abs(
      middle(spinner.getBoundingClientRect()) -
        middle(row('Implement Teams').getBoundingClientRect())
    )
  ).toBeLessThan(1);
  expect(row('Implement Teams')).toHaveAccessibleName(/; running$/);
  expect(row('Remediate')).toHaveAccessibleName(/branch preset-io\/agor \/ feature\/teams-gateway/);

  // Failed rows are tinted; read rows recede one step; attention rows stay full strength.
  const probe = document.createElement('span');
  document.body.append(probe);
  const resolve = (value: string) => {
    probe.style.color = value;
    return getComputedStyle(probe).color;
  };
  expect(getComputedStyle(row('Remediate').parentElement!).backgroundColor).toBe(
    resolve(token.colorErrorBg)
  );
  expect(within(row('Remediate')).getByRole('img', { name: 'Latest task failed' })).toBeVisible();
  const titleColor = (name: string) =>
    getComputedStyle(within(row(name)).getByText(new RegExp(`^${name}`))).color;
  expect(titleColor('Resync')).toBe(resolve(token.colorTextSecondary));
  expect(titleColor('Final independent')).not.toBe(resolve(token.colorTextSecondary));
  probe.remove();
  await page.screenshot({ path: `./.vitest/board-session-list-${window.innerWidth}.png` });
});

it('reveals time and the board locator on hover or focus and opens rows by keyboard', async () => {
  const { onSessionClick } = mount();
  const target = row('Resync');
  // The toolbar mounts once the list is idle (or on first hover/focus), hidden until used.
  const toolbar = await waitFor(() =>
    within(target.parentElement!).getByRole('group', { name: 'Session actions' })
  );
  expect(getComputedStyle(toolbar).opacity).toBe('0');
  expect(getComputedStyle(target.parentElement!).backgroundColor).toBe(TRANSPARENT);

  await act(async () => page.elementLocator(target).hover());
  await waitFor(() => expect(getComputedStyle(toolbar).opacity).toBe('1'));
  expect(within(toolbar).getByText('5m ago')).toBeVisible();
  expect(within(toolbar).getByRole('button', { name: 'Go to card on board' })).toBeVisible();
  expect(getComputedStyle(target.parentElement!).backgroundColor).not.toBe(TRANSPARENT);
  // A leading fade lets covered branch text run out instead of cutting mid-word.
  expect(getComputedStyle(toolbar).backgroundImage).toMatch(
    new RegExp(`^linear-gradient\\(to right, ${TRANSPARENT.replace(/[()]/g, '\\$&')}`)
  );
  // The toolbar sits on the row's first line, centered.
  const center = (rect: DOMRect) => rect.top + rect.height / 2;
  expect(
    Math.abs(center(toolbar.getBoundingClientRect()) - center(target.getBoundingClientRect()))
  ).toBeLessThan(1);

  // Locating a card does not open the session.
  await act(async () =>
    page
      .elementLocator(within(toolbar).getByRole('button', { name: 'Go to card on board' }))
      .click()
  );
  expect(onSessionClick).not.toHaveBeenCalled();

  act(() => row('Final independent').focus());
  await act(async () => userEvent.keyboard('{Enter}'));
  expect(onSessionClick).toHaveBeenCalledExactlyOnceWith('ready');
});

it('adds search context on a second line without breaking the row', async () => {
  mount();
  fireEvent.change(screen.getByPlaceholderText(/search sessions/i), {
    target: { value: 'authority' },
  });
  const result = await waitFor(() => row('Remediate'));
  expect(within(result).getByText(/Snapshot migrations broke the/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Open session Resync/ })).toBeNull();
});
