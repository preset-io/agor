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

function mount(
  list: Session[] = sessions,
  options: { motion?: boolean; fillAvailableHeight?: boolean } = {}
) {
  const themeConfig = { ...config, token: { ...config.token, motion: options.motion ?? false } };
  const handlers = {
    onSessionClick: vi.fn(),
    onCreateSession: vi.fn(),
    onOpenSessionSettings: vi.fn(),
  };
  const ui = (rowHandlers: typeof handlers) => (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <ConfigProvider theme={themeConfig}>
        <App style={{ background: theme.getDesignToken(config).colorBgContainer, minHeight: 600 }}>
          <div
            data-testid="panel"
            style={{
              width: 360,
              padding: 12,
              // The teammate panel supplies a bounded flex column in fill mode.
              ...(options.fillAvailableHeight
                ? { height: 560, display: 'flex', flexDirection: 'column' as const }
                : undefined),
            }}
          >
            <BranchSessionSections
              fillAvailableHeight={options.fillAvailableHeight}
              branch={branch}
              sessions={list}
              userById={new Map()}
              selectedSessionId="review"
              mode="panel"
              client={null}
              {...rowHandlers}
            />
          </div>
        </App>
      </ConfigProvider>
    </ConnectionProvider>
  );
  const view = render(ui(handlers));
  return {
    ...handlers,
    rerenderWith: (next: Partial<typeof handlers>) => view.rerender(ui({ ...handlers, ...next })),
  };
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

  // Rows sit flush: their own hover/selection fill separates them, so pitch is the row height.
  expect(
    row('Astra recheck — Abuse').getBoundingClientRect().top -
      row('Security agor').getBoundingClientRect().top
  ).toBeCloseTo(expectedHeight, 0);

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

it('shows the agent logo on every row and hides only the implied spawn marker', () => {
  mount();

  // One steady brand column: every row shows its agent, so titles stay aligned.
  for (const session of sessions) {
    expect(row(session.title!).querySelector('.tool-icon')).not.toBeNull();
  }
  expect(row('Astra recheck — Abuse').querySelector('[aria-label="subnode"]')).toBeNull();
  expect(
    row('Execution security — regression-safe').querySelector('[aria-label="fork"]')
  ).not.toBeNull();

  const titleLeft = (title: string) =>
    within(row(title))
      .getByText(new RegExp(`^${title}`))
      .getBoundingClientRect().left;
  expect(titleLeft('Availability fixes')).toBeCloseTo(titleLeft('Independent availability'), 0);
});

it('nests rows one level inside their section with one chevron style', () => {
  mount();
  const step = theme.getDesignToken(config).controlHeightSM;

  const headerChevron = document.querySelector('.ant-collapse-expand-icon svg')!;
  const treeChevron = screen
    .getByRole('button', { name: 'Collapse Security agor' })
    .querySelector('svg')!;
  const header = headerChevron.getBoundingClientRect();
  const tree = treeChevron.getBoundingClientRect();
  expect(header.width).toBeCloseTo(tree.width, 1);
  expect(getComputedStyle(headerChevron).color).toBe(getComputedStyle(treeChevron).color);
  // Sections are containers: top-level rows sit exactly one indent step inside the header.
  expect(tree.left + tree.width / 2 - (header.left + header.width / 2)).toBeCloseTo(step, 0);
  expect(
    row('Security agor').querySelector('.tool-icon')!.getBoundingClientRect().left -
      screen.getByText('Sessions').getBoundingClientRect().left
  ).toBeCloseTo(step, 0);

  // A guide runs under the section chevron, and every nested level draws its own guide.
  const body = treeChevron.closest('.ant-collapse-body')!;
  expect(getComputedStyle(body).borderInlineStartWidth).not.toBe('0px');
  const childUnit = row('Astra recheck — Abuse')
    .closest('.ant-tree-treenode')!
    .querySelector('.ant-tree-indent-unit')!;
  const guide = getComputedStyle(childUnit, '::before');
  expect(guide.display).not.toBe('none');
  expect(guide.borderInlineEndWidth).not.toBe('0px');
  // The guide sits under its parent's chevron, not beside it.
  const unit = childUnit.getBoundingClientRect();
  expect(unit.right - parseFloat(guide.insetInlineEnd)).toBeCloseTo(tree.left + tree.width / 2, 0);
  // Tree's own first-line switcher backing is replaced by the button's hover surface.
  const switcher = treeChevron.closest('.ant-tree-switcher')!;
  expect(getComputedStyle(switcher, '::before').display).toBe('none');
});

it('toggles in one frame, animates only revealed rows, and defers hover toolbars', async () => {
  mount(sessions, { motion: true, fillAvailableHeight: true });

  // Nothing animates on first render. Toolbars skip the initial commit, then mount in idle
  // time so browse-mode screen readers can still reach them.
  expect(document.querySelector('.agor-session-row-enter')).toBeNull();
  expect(document.querySelectorAll('[aria-label="setting"]')).toHaveLength(0);
  await waitFor(() =>
    expect(document.querySelectorAll('[aria-label="setting"]')).toHaveLength(sessions.length)
  );

  // The list is sized to its content in the same commit: no clipped row, no trailing gap.
  const holder = document.querySelector<HTMLElement>('.ant-tree-list-holder')!;
  const expectSettled = () => {
    // The virtual spacer is the rows' total height; the viewport must match it exactly.
    const viewport = holder.getBoundingClientRect();
    expect(viewport.height).toBeCloseTo(
      holder.firstElementChild!.getBoundingClientRect().height,
      0
    );
    const rows = holder.querySelectorAll('[data-session-id]');
    expect(rows[rows.length - 1]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.bottom + 0.5
    );
  };

  // Tree height motion is off: children leave in the same commit, with no motion holder.
  await act(async () =>
    page.getByRole('button', { name: 'Collapse Astra recheck — Abuse/availability' }).click()
  );
  expect(screen.queryByText(/^Availability fixes/)).toBeNull();
  expect(document.querySelector('.ant-tree-treenode-motion')).toBeNull();
  expectSettled();
  expect(document.querySelector('.agor-session-row-enter')).toBeNull();

  // Record which rows receive the reveal class; the class clears after the animation,
  // so checking it after a slow (CI) click round-trip would race.
  const animated = new Set<string>();
  const recordAnimated = () =>
    document.querySelectorAll('.agor-session-row-enter [data-session-id]').forEach((el) => {
      animated.add(el.getAttribute('data-session-id')!);
    });
  const observer = new MutationObserver(recordAnimated);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  await act(async () =>
    page.getByRole('button', { name: 'Expand Astra recheck — Abuse/availability' }).click()
  );
  observer.disconnect();
  expectSettled();
  // Only the rows the expand revealed play the compositor-only enter animation.
  expect([...animated].sort()).toEqual(['fixes', 'review']);
  await waitFor(() => expect(document.querySelector('.agor-session-row-enter')).toBeNull(), {
    timeout: 2000,
  });
});

it('skips the reveal animation when the theme turns motion off', async () => {
  mount();

  await act(async () =>
    page.getByRole('button', { name: 'Collapse Astra recheck — Abuse/availability' }).click()
  );
  await act(async () =>
    page.getByRole('button', { name: 'Expand Astra recheck — Abuse/availability' }).click()
  );
  expect(row('Availability fixes')).toBeVisible();
  expect(document.querySelector('.agor-session-row-enter')).toBeNull();
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

it('keeps gateway channels on the title line and scheduled runs on the title column', () => {
  mount([
    ...sessions,
    makeSession('nightly', 'Nightly dependency audit', {
      scheduled_from_branch: true,
      scheduled_run_at: 1_780_527_200_000,
    }),
    makeSession('weekly', 'Weekly security digest', {
      scheduled_from_branch: true,
      scheduled_run_at: 1_780_440_800_000,
    }),
    makeSession('slack', 'Why is the staging deploy stuck?', {
      custom_context: {
        gateway_source: {
          channel_id: 'channel-1',
          channel_type: 'slack',
          channel_name: '#eng-deploys',
          thread_id: 'thread-1',
        },
      },
    } as Partial<Session>),
  ]);

  const expectedHeight = isMobileViewport()
    ? MOBILE_TOUCH_TARGET
    : theme.getDesignToken(config).controlHeight;
  const gateway = row('Why is the staging deploy stuck?');
  expect(within(gateway).getByText('#eng-deploys')).toBeVisible();
  expect(gateway.querySelector('.ant-tag')).toBeNull();
  expect(gateway.getBoundingClientRect().height).toBeCloseTo(expectedHeight, 0);
  // Paged scheduled rows keep the same flush rhythm as tree rows.
  expect(
    row('Weekly security digest').getBoundingClientRect().top -
      row('Nightly dependency audit').getBoundingClientRect().top
  ).toBeCloseTo(expectedHeight, 0);

  // Every section shares one title column and the same read-state tone.
  const title = (name: string) => within(row(name)).getByText(new RegExp(`^${name}`));
  const sessionTitle = title('Astra recheck — Abuse');
  for (const name of ['Nightly dependency audit', 'Why is the staging deploy stuck?']) {
    expect(title(name).getBoundingClientRect().left).toBeCloseTo(
      title('Security agor').getBoundingClientRect().left,
      0
    );
    expect(getComputedStyle(title(name)).color).toBe(getComputedStyle(sessionTitle).color);
  }
});

it('lets read sessions recede one step while sessions that need you stay full strength', () => {
  mount();
  const token = theme.getDesignToken(config);
  const color = (name: string) =>
    getComputedStyle(within(row(name)).getByText(new RegExp(`^${name}`))).color;
  const probe = document.createElement('span');
  document.body.append(probe);
  const resolve = (value: string) => {
    probe.style.color = value;
    return getComputedStyle(probe).color;
  };

  // Ready, running, failed and selected rows keep the normal text color.
  for (const name of [
    'Security agor',
    'Availability fixes',
    'Execution security — implementation',
    'Independent availability',
  ]) {
    expect(color(name)).not.toBe(resolve(token.colorTextSecondary));
  }
  // Read rows use the gentler secondary step, not the description grey.
  expect(color('Astra recheck — Abuse')).toBe(resolve(token.colorTextSecondary));
  expect(color('Execution security — regression-safe')).toBe(resolve(token.colorTextSecondary));
  probe.remove();
});

it('re-renders memoized rows when a context-only input changes', async () => {
  const { onOpenSessionSettings, rerenderWith } = mount();
  const replacement = vi.fn();
  rerenderWith({ onOpenSessionSettings: replacement });

  await act(async () => page.elementLocator(row('Astra recheck — Abuse')).hover());
  const actions = row('Astra recheck — Abuse').parentElement!.lastElementChild as HTMLElement;
  await act(async () =>
    page.elementLocator(within(actions).getByRole('button', { name: 'setting' })).click()
  );
  // A stale memoized row would still call the handler from the first render.
  expect(replacement).toHaveBeenCalledWith('abuse');
  expect(onOpenSessionSettings).not.toHaveBeenCalled();
});

it('tints failed rows, drops the logo outline, and gives the status mark trailing room', () => {
  mount();
  const token = theme.getDesignToken(config);
  const probe = document.createElement('span');
  document.body.append(probe);
  const resolve = (value: string) => {
    probe.style.color = value;
    return getComputedStyle(probe).color;
  };

  // A failed session highlights its whole row and keeps the icon, so color isn't the only cue.
  const failed = row('Execution security — implementation');
  expect(getComputedStyle(failed).backgroundColor).toBe(resolve(token.colorErrorBg));
  expect(within(failed).getByRole('img', { name: 'Latest task failed' })).toBeVisible();
  expect(getComputedStyle(row('Astra recheck — Abuse')).backgroundColor).toBe(TRANSPARENT);

  expect(getComputedStyle(row('Security agor').querySelector('.tool-icon')!).borderTopWidth).toBe(
    '0px'
  );

  const style = getComputedStyle(row('Security agor'));
  expect(parseFloat(style.paddingRight)).toBe(token.paddingSM);
  expect(parseFloat(style.paddingLeft)).toBe(token.paddingXXS);
  probe.remove();
});

it.each([
  ['dark', theme.darkAlgorithm],
  ['light', theme.defaultAlgorithm],
] as const)('keeps a selected failed row visibly selected in the %s theme', (_, algorithm) => {
  const themed = { algorithm, token: { motion: false } };
  const ui = (selectedSessionId?: string) => (
    <ConfigProvider theme={themed}>
      <App>
        <div style={{ width: 360 }}>
          <BranchSessionSections
            branch={branch}
            sessions={sessions}
            userById={new Map()}
            selectedSessionId={selectedSessionId}
            mode="panel"
            client={null}
          />
        </div>
      </App>
    </ConfigProvider>
  );
  const background = () =>
    getComputedStyle(row('Execution security — implementation')).backgroundColor;

  const view = render(ui());
  const unselected = background();
  view.rerender(ui('exec-impl'));
  const selected = background();

  // Channel distance, so a one-unit token rounding difference doesn't count as "selected".
  const channels = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number);
  const [a, b] = [channels(unselected), channels(selected)];
  expect(Math.max(...a.map((v, i) => Math.abs(v - b[i]!)))).toBeGreaterThan(10);
});
