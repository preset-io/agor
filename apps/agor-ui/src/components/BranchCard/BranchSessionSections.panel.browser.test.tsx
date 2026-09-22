import type { Branch, Session } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../index.css';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { isMobileViewport, MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { BranchSessionSections } from './BranchSessionSections';

// biome-ignore lint/plugin/noHardcodedColorLiteral: browser-computed transparency sentinel, not a UI palette
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

const branch = { branch_id: 'panel-branch', name: 'Panel', filesystem_status: 'ready' } as Branch;

function makeSession(
  id: string,
  title: string,
  overrides: Partial<Session> & { parent?: string; forkedFrom?: string } = {}
): Session {
  const { parent, forkedFrom, ...rest } = overrides;
  return {
    session_id: id,
    branch_id: branch.branch_id,
    title,
    agentic_tool: 'codex',
    status: 'idle',
    archived: false,
    ready_for_prompt: false,
    created_at: '2026-09-01T00:00:00.000Z',
    last_updated: '2026-09-01T00:00:00.000Z',
    genealogy: {
      children: [],
      ...(parent ? { parent_session_id: parent } : {}),
      ...(forkedFrom ? { forked_from_session_id: forkedFrom } : {}),
    },
    ...rest,
  } as Session;
}

const sessions: Session[] = [
  makeSession('root', 'Security agor', { ready_for_prompt: true }),
  makeSession('abuse', 'Astra recheck — Abuse/availability', { parent: 'root' }),
  makeSession('fixes', 'Availability fixes and regression proof — Astra xhigh', {
    parent: 'abuse',
    status: 'running',
  }),
  makeSession('review', 'Independent availability fix review — Astra xhigh', {
    parent: 'abuse',
    agentic_tool: 'claude-code',
    ready_for_prompt: true,
  }),
  makeSession('exec', 'Astra recheck — Execution authority', { parent: 'root' }),
  makeSession('exec-impl', 'Execution security — implementation and regression validation', {
    parent: 'exec',
    status: 'failed',
  }),
  makeSession('exec-plan', 'Execution security — regression-safe remediation plan', {
    forkedFrom: 'exec',
  }),
];

const config = { algorithm: theme.darkAlgorithm, token: { motion: false } };

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function mount(list: Session[] = sessions) {
  const handlers = {
    onSessionClick: vi.fn(),
    onCreateSession: vi.fn(),
    onOpenSessionSettings: vi.fn(),
  };
  render(
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <ConfigProvider theme={config}>
        <App style={{ background: theme.getDesignToken(config).colorBgContainer, minHeight: 600 }}>
          <div data-testid="panel" style={{ width: 360, padding: 12 }}>
            <BranchSessionSections
              branch={branch}
              sessions={list}
              userById={new Map()}
              selectedSessionId="review"
              mode="panel"
              client={null}
              {...handlers}
            />
          </div>
        </App>
      </ConfigProvider>
    </ConnectionProvider>
  );
  return handlers;
}

const row = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`^Open session ${title}`) });

it('renders borderless single-line rows with status carried by a trailing dot', async () => {
  const { onCreateSession } = mount();
  const expectedHeight = isMobileViewport()
    ? MOBILE_TOUCH_TARGET
    : theme.getDesignToken(config).controlHeight;

  for (const session of sessions) {
    const element = row(session.title!);
    const style = getComputedStyle(element);
    expect(style.borderTopWidth).toBe('0px');
    expect(style.boxShadow).toBe('none');
    expect(style.outlineStyle).toBe('none');
    expect(element.getBoundingClientRect().height).toBeCloseTo(expectedHeight, 0);
    const caret = element.closest('.ant-tree-treenode')!.querySelector('.ant-tree-switcher svg');
    if (caret) {
      const center = (rect: DOMRect) => rect.top + rect.height / 2;
      expect(
        Math.abs(center(caret.getBoundingClientRect()) - center(element.getBoundingClientRect()))
      ).toBeLessThan(1);
    }
  }

  // Long single-line titles ellipsize inside the panel instead of pushing rows past it.
  const panelRight = screen.getByTestId('panel').getBoundingClientRect().right;
  for (const session of sessions) {
    expect(row(session.title!).getBoundingClientRect().right).toBeLessThanOrEqual(panelRight);
  }
  for (const dot of screen.getAllByRole('img', { name: /Ready|Running|failed/ })) {
    expect(dot.getBoundingClientRect().right).toBeLessThanOrEqual(panelRight);
  }

  // Tree's own 4px node gap is the only spacing between borderless rows.
  expect(
    row('Astra recheck — Abuse').getBoundingClientRect().top -
      row('Security agor').getBoundingClientRect().top
  ).toBeCloseTo(expectedHeight + 4, 0);

  expect(within(row('Security agor')).getByRole('img', { name: 'Ready for prompt' })).toBeVisible();
  expect(within(row('Availability fixes')).getByRole('img', { name: 'Running' })).toHaveClass(
    'status-dot-run'
  );
  expect(
    within(row('Execution security — implementation')).getByRole('img', {
      name: 'Latest task failed',
    })
  ).toBeVisible();
  // Status marks are visual only; the row name carries the same state.
  expect(row('Execution security — implementation')).toHaveAccessibleName(/; latest task failed$/);
  expect(row('Availability fixes')).toHaveAccessibleName(/; running$/);
  expect(row('Security agor')).toHaveAccessibleName(/; ready for prompt$/);
  expect(row('Astra recheck — Abuse')).toHaveAccessibleName(
    'Open session Astra recheck — Abuse/availability'
  );
  expect(
    within(row('Astra recheck — Abuse')).queryByRole('img', { name: /Ready|Running|failed/ })
  ).toBeNull();

  // Selection is a fill, not the card-mode dashed outline.
  expect(getComputedStyle(row('Independent availability')).backgroundColor).not.toBe(TRANSPARENT);
  expect(getComputedStyle(row('Astra recheck — Abuse')).backgroundColor).toBe(TRANSPARENT);

  await act(async () => page.getByRole('button', { name: 'New Session' }).click());
  expect(onCreateSession).toHaveBeenCalledWith(branch.branch_id);
  await page.screenshot({ path: `./.vitest/panel-sessions-${window.innerWidth}.png` });
  await act(async () => page.elementLocator(row('Astra recheck — Execution')).hover());
  await page.screenshot({ path: `./.vitest/panel-sessions-hover-${window.innerWidth}.png` });
});

it('shows agent icons only where the agent changes and hides the implied spawn marker', () => {
  mount();

  const iconVisible = (title: string) =>
    getComputedStyle(row(title).querySelector('.tool-icon')!).visibility === 'visible';
  expect(iconVisible('Security agor')).toBe(true);
  expect(iconVisible('Astra recheck — Abuse')).toBe(false);
  expect(iconVisible('Independent availability')).toBe(true);
  expect(row('Astra recheck — Abuse').querySelector('[aria-label="subnode"]')).toBeNull();
  expect(
    row('Execution security — regression-safe').querySelector('[aria-label="fork"]')
  ).not.toBeNull();

  // Hidden icons keep their slot so sibling titles stay aligned.
  const siblingLeft = (title: string) =>
    within(row(title))
      .getByText(new RegExp(`^${title}`))
      .getBoundingClientRect().left;
  expect(siblingLeft('Availability fixes')).toBeCloseTo(siblingLeft('Independent availability'), 0);
});

it('keeps hover actions and collapse behavior, and counts hidden children', async () => {
  const { onOpenSessionSettings, onSessionClick } = mount();
  const target = row('Astra recheck — Abuse');

  await act(async () => page.elementLocator(target).hover());
  const actions = target.parentElement!.lastElementChild as HTMLElement;
  await waitFor(() => expect(getComputedStyle(actions).opacity).toBe('1'));
  const settings = within(actions).getByRole('button', { name: 'setting' });
  await act(async () => page.elementLocator(settings).click());
  expect(onOpenSessionSettings).toHaveBeenCalledWith('abuse');
  expect(onSessionClick).not.toHaveBeenCalled();

  await act(async () =>
    page.getByRole('button', { name: 'Collapse Astra recheck — Abuse/availability' }).click()
  );
  await waitFor(() => expect(screen.queryByText(/^Availability fixes/)).toBeNull());
  expect(within(row('Astra recheck — Abuse')).getByText('2')).toBeVisible();
  expect(row('Astra recheck — Abuse')).toHaveAccessibleName(/; 2 hidden child sessions$/);

  await act(async () =>
    page.getByRole('button', { name: 'Expand Astra recheck — Abuse/availability' }).click()
  );
  expect(row('Availability fixes')).toBeVisible();
  expect(within(row('Astra recheck — Abuse')).queryByText('2')).toBeNull();

  await act(async () => page.elementLocator(row('Astra recheck — Abuse')).click());
  expect(onSessionClick).toHaveBeenCalledExactlyOnceWith('abuse');
});

it('applies the same row treatment to scheduled runs and flat search results', async () => {
  mount([
    ...sessions,
    makeSession('nightly', 'Nightly dependency audit', {
      scheduled_from_branch: true,
      scheduled_run_at: 1_780_527_200_000,
      ready_for_prompt: true,
    }),
  ]);

  const scheduled = row('Nightly dependency audit');
  expect(getComputedStyle(scheduled).borderTopWidth).toBe('0px');
  expect(within(scheduled).getByRole('img', { name: 'Ready for prompt' })).toBeVisible();
  expect(screen.getByText('Scheduled Runs')).toBeVisible();

  fireEvent.change(screen.getByPlaceholderText(/search sessions/i), {
    target: { value: 'Execution security' },
  });
  const result = await waitFor(() => row('Execution security — implementation'));
  expect(getComputedStyle(result).borderTopWidth).toBe('0px');
  expect(within(result).getByRole('img', { name: 'Latest task failed' })).toBeVisible();
  const wrapper = result.parentElement!;
  expect(getComputedStyle(wrapper).backgroundColor).toBe(TRANSPARENT);
  await act(async () => page.elementLocator(result).hover());
  await waitFor(() => expect(getComputedStyle(wrapper).backgroundColor).not.toBe(TRANSPARENT));
});
