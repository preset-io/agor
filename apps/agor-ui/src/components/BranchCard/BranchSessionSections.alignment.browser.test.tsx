import type { Branch, Session } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../index.css';
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

it('centers hovered session borders and actions without changing row pitch at canvas zooms', async () => {
  const { onSessionClick, onOpenSessionSettings } = mount();
  const rows = sessions.map((session) =>
    screen.getByRole('button', { name: `Open session ${session.title}` })
  );
  for (const zoom of [0.65, 1, 1.75]) {
    screen.getByTestId('canvas').style.transform = `scale(${zoom})`;
    for (const row of rows) {
      await act(async () => page.elementLocator(row).hover());
      const surface = row.closest<HTMLElement>('.ant-tree-node-content-wrapper')!;
      const node = row.closest<HTMLElement>('.ant-tree-treenode')!;
      const actions = row.parentElement!.lastElementChild as HTMLElement;
      await waitFor(() => {
        const border = row.getBoundingClientRect();
        const fill = surface.getBoundingClientRect();
        expect(Math.abs(centerY(border) - centerY(fill))).toBeLessThan(0.1);
        expect(Math.abs(centerY(border) - centerY(actions.getBoundingClientRect()))).toBeLessThan(
          0.1
        );
        // Preserve the original 4px total inset and 4px inter-node gap.
        expect((fill.height - border.height) / zoom).toBeCloseTo(4, 1);
        expect(node.getBoundingClientRect().height / zoom).toBeCloseTo(border.height / zoom + 4, 1);
        expect(getComputedStyle(actions).opacity).toBe('1');
      });
      expect(getComputedStyle(surface).backgroundColor).not.toBe(TRANSPARENT);
      const bounds = row.getBoundingClientRect();
      expect(
        row.contains(document.elementFromPoint(bounds.left + 10 * zoom, centerY(bounds)))
      ).toBe(true);
    }
    const parentNode = rows[0].closest('.ant-tree-treenode')!.getBoundingClientRect();
    const childNode = rows[1].closest('.ant-tree-treenode')!.getBoundingClientRect();
    expect((childNode.top - parentNode.bottom) / zoom).toBeCloseTo(4, 1);
    expect(getComputedStyle(rows[1]).outlineStyle).toBe('dashed');
    expect(getComputedStyle(rows[0]).borderStyle).toBe('solid');
  }
  await page.screenshot({ path: `./.vitest/alignment-row-${window.innerWidth}.png` });
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
  expect(getComputedStyle(rows[1]).outlineStyle).toBe('dashed');
});

it.each([24, 32])(
  'centers plus/minus glyphs in the hover backing and preserves connector and hit targets (line %ipx)',
  async (titleHeight) => {
    const { onSessionClick } = mount(titleHeight);
    for (const zoom of [0.65, 1, 1.75]) {
      screen.getByTestId('canvas').style.transform = `scale(${zoom})`;
      const button = screen.getByRole('button', { name: 'Collapse Parent' });
      await act(async () => page.elementLocator(button).hover());
      const switcher = button.parentElement!;
      const backing = getComputedStyle(switcher, '::before');
      const glyph = button.querySelector('svg')!.getBoundingClientRect();
      const bounds = switcher.getBoundingClientRect();
      const backingCenter =
        bounds.top + (parseFloat(backing.top) + parseFloat(backing.height) / 2) * zoom;
      expect(Math.abs(centerY(glyph) - backingCenter)).toBeLessThan(0.1);
      expect(
        Math.abs(glyph.left + glyph.width / 2 - (bounds.left + bounds.width / 2))
      ).toBeLessThan(0.1);
      expect(backing.backgroundColor).not.toBe(TRANSPARENT);
      expect(button.getBoundingClientRect().height / zoom).toBeCloseTo(titleHeight, 1);
      expect(button.getBoundingClientRect().width).toBeCloseTo(bounds.width, 1);
      // AntD's leaf connector meets the same first-line center, not the center of a tall row.
      const leafLine = document.querySelector('.ant-tree-switcher-leaf-line')!;
      expect(parseFloat(getComputedStyle(leafLine, '::after').height)).toBe(titleHeight / 2);
      expect(parseFloat(getComputedStyle(leafLine, '::before').height)).toBe(titleHeight / 2);
      await act(async () => page.elementLocator(button).click());
      const expand = screen.getByRole('button', { name: 'Expand Parent' });
      expect(
        screen.queryByRole('button', { name: `Open session ${sessions[1].title}` })
      ).toBeNull();
      expect(
        Math.abs(centerY(expand.querySelector('svg')!.getBoundingClientRect()) - backingCenter)
      ).toBeLessThan(0.1);
      await act(async () => userEvent.keyboard('{Enter}'));
      expect(screen.getByRole('button', { name: 'Collapse Parent' })).toHaveFocus();
      expect(
        screen.getByRole('button', { name: `Open session ${sessions[1].title}` })
      ).toBeVisible();
    }
    await page.screenshot({
      path: `./.vitest/alignment-switcher-${titleHeight}-${window.innerWidth}.png`,
    });
    expect(onSessionClick).not.toHaveBeenCalled();
  }
);
