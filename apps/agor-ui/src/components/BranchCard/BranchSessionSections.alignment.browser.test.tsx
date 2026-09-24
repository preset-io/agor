import type { Branch, Session } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../index.css';
import { isMobileViewport, MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { BranchSessionSections } from './BranchSessionSections';

// biome-ignore lint/plugin/noHardcodedColorLiteral: browser-computed transparency sentinel, not a UI palette
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

const branch = {
  branch_id: 'alignment-branch',
  name: 'Alignment',
  filesystem_status: 'ready',
} as Branch;

const sessions: Session[] = [
  'Parent',
  'Close D4.1 — align the mint gate with the agent-facing status read',
].map((title, index) => ({
  session_id: `alignment-${index}` as Session['session_id'],
  branch_id: branch.branch_id,
  title,
  agentic_tool: 'codex',
  status: 'idle',
  archived: false,
  created_by: 'user-1',
  unix_username: null,
  sdk_home_scope: 'branch',
  url: null,
  contextFiles: [],
  tasks: [],
  scheduled_from_branch: false,
  ready_for_prompt: false,
  created_at: '2026-09-01T00:00:00.000Z',
  last_updated: '2026-09-01T00:00:00.000Z',
  genealogy: {
    children: [],
    ...(index ? { parent_session_id: 'alignment-0' as Session['session_id'] } : {}),
  },
}));

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function mount(titleHeight = 24) {
  const onSessionClick = vi.fn();
  const onOpenSessionSettings = vi.fn();
  const config = {
    algorithm: theme.darkAlgorithm,
    token: { motion: false },
    components: { Tree: { titleHeight } },
  };
  render(
    <ConfigProvider theme={config}>
      <App style={{ background: theme.getDesignToken(config).colorBgContainer, minHeight: 800 }}>
        <div data-testid="canvas" style={{ width: 340, transformOrigin: 'top left' }}>
          <BranchSessionSections
            branch={branch}
            sessions={sessions}
            userById={new Map()}
            selectedSessionId={sessions[1].session_id}
            onSessionClick={onSessionClick}
            onOpenSessionSettings={onOpenSessionSettings}
            client={null}
          />
        </div>
      </App>
    </ConfigProvider>
  );
  return { onSessionClick, onOpenSessionSettings };
}

const centerY = (rect: DOMRect) => rect.top + rect.height / 2;
const ZOOMS = [0.65, 1, 1.75];
const rowName = (title: string) => new RegExp(`^Open session ${title}(;|$)`);

it('keeps card rows, chevrons and hover actions aligned at canvas zooms', async () => {
  const { onSessionClick, onOpenSessionSettings } = mount();
  const rowHeight = isMobileViewport()
    ? MOBILE_TOUCH_TARGET
    : theme.getDesignToken({ algorithm: theme.darkAlgorithm }).controlHeight;
  const rows = sessions.map((session) =>
    screen.getByRole('button', { name: rowName(session.title!) })
  );
  for (const zoom of ZOOMS) {
    screen.getByTestId('canvas').style.transform = `scale(${zoom})`;
    for (const row of rows) {
      await act(async () => page.elementLocator(row).hover());
      const actions = row.parentElement!.lastElementChild as HTMLElement;
      await waitFor(() => {
        expect(getComputedStyle(actions).opacity).toBe('1');
        const bounds = row.getBoundingClientRect();
        // Borderless single-line rows share the panel's row height and pitch.
        expect(bounds.height / zoom).toBeCloseTo(rowHeight, 0);
        expect(Math.abs(centerY(bounds) - centerY(actions.getBoundingClientRect()))).toBeLessThan(
          0.5
        );
      });
      expect(getComputedStyle(row).borderTopWidth).toBe('0px');
      const bounds = row.getBoundingClientRect();
      expect(
        row.contains(document.elementFromPoint(bounds.left + 10 * zoom, centerY(bounds)))
      ).toBe(true);
    }
    // A one-size-unit gap separates adjacent fills.
    expect(
      (rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom) / zoom
    ).toBeCloseTo(theme.getDesignToken({ algorithm: theme.darkAlgorithm }).sizeUnit, 0);
    // The chevron is centered on its row, not on Tree's first line.
    const chevron = screen.getByRole('button', { name: 'Collapse Parent' }).querySelector('svg')!;
    expect(
      Math.abs(centerY(chevron.getBoundingClientRect()) - centerY(rows[0].getBoundingClientRect()))
    ).toBeLessThan(0.5);
    // Selection is a fill, not the old dashed outline.
    expect(getComputedStyle(rows[1]).outlineStyle).toBe('none');
    expect(getComputedStyle(rows[1]).backgroundColor).not.toBe(TRANSPARENT);
    expect(getComputedStyle(rows[0]).backgroundColor).toBe(TRANSPARENT);
  }
  await page.screenshot({ path: `./.vitest/alignment-card-${window.innerWidth}.png` });

  const settings = rows[1]
    .parentElement!.querySelector('[aria-label="setting"]')!
    .closest('button')!;
  await act(async () => page.elementLocator(settings).click());
  expect(onOpenSessionSettings).toHaveBeenCalledWith(sessions[1].session_id);
  expect(onSessionClick).not.toHaveBeenCalled();
  await act(async () => page.elementLocator(rows[1]).click());
  expect(onSessionClick).toHaveBeenCalledExactlyOnceWith(sessions[1].session_id);
  await act(async () => page.getByText('Sessions', { exact: true }).hover());
  const actions = rows[1].parentElement!.lastElementChild as HTMLElement;
  expect(getComputedStyle(actions).opacity).toBe('1'); // Keyboard focus still exposes actions.
  act(() => rows[1].blur());
  await waitFor(() => expect(getComputedStyle(actions).opacity).toBe('0'));
  expect(getComputedStyle(actions).pointerEvents).toBe('none');
});

it('shows the full title in a tooltip only for truncated card rows', async () => {
  mount();
  const [fits, truncated] = sessions.map((session) =>
    within(screen.getByRole('button', { name: rowName(session.title!) })).getByText(session.title!)
  );
  expect(fits.scrollWidth).toBeLessThanOrEqual(fits.clientWidth);
  await act(async () => page.elementLocator(fits).hover());
  await act(() => new Promise((resolve) => setTimeout(resolve, 800)));
  expect(screen.queryByRole('tooltip')).toBeNull();

  expect(truncated.scrollWidth).toBeGreaterThan(truncated.clientWidth);
  await act(async () => page.elementLocator(truncated).hover());
  expect(await screen.findByRole('tooltip', {}, { timeout: 2000 })).toHaveTextContent(
    sessions[1].title!
  );
  await page.screenshot({ path: `./.vitest/title-tooltip-card-${window.innerWidth}.png` });
});

it('toggles card subtrees with the chevron by mouse and keyboard at canvas zooms', async () => {
  const { onSessionClick } = mount();
  const child = () => screen.queryByRole('button', { name: rowName(sessions[1].title!) });
  for (const zoom of ZOOMS) {
    screen.getByTestId('canvas').style.transform = `scale(${zoom})`;
    await act(async () => page.getByRole('button', { name: 'Collapse Parent' }).click());
    expect(child()).toBeNull();
    // Focus stays on the chevron, so Enter re-expands from the keyboard.
    expect(screen.getByRole('button', { name: 'Expand Parent' })).toHaveFocus();
    await act(async () => userEvent.keyboard('{Enter}'));
    expect(screen.getByRole('button', { name: 'Collapse Parent' })).toHaveFocus();
    expect(child()).toBeVisible();
  }
  expect(onSessionClick).not.toHaveBeenCalled();
});
