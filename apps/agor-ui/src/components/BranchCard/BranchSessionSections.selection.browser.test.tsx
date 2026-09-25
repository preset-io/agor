import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../index.css';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from '../BoardTeammatePanel/BoardTeammatePanel';
import BranchCard from './BranchCard';
import { BranchSessionSections } from './BranchSessionSections';

const branch = {
  branch_id: 'selection-branch',
  repo_id: 'selection-repo',
  name: 'Session selection',
  filesystem_status: 'ready',
} as Branch;
const repo = { repo_id: branch.repo_id, slug: 'fixture/selection' } as Repo;
const sessions = [
  ['parent', 'Plan the release', 'idle'],
  [
    'child',
    'Review a very long session name without crowding the status mark or actions',
    'failed',
  ],
  ['sibling', 'Run the regression suite', 'running'],
].map(([id, title, status], index) => ({
  session_id: id,
  branch_id: branch.branch_id,
  title,
  status,
  agentic_tool: 'codex',
  archived: false,
  ready_for_prompt: index === 0,
  created_at: '2026-09-01T00:00:00.000Z',
  last_updated: '2026-09-01T00:00:00.000Z',
  genealogy: { children: [], ...(index ? { parent_session_id: 'parent' } : {}) },
})) as Session[];

beforeEach(() => {
  localStorage.clear();
  agorStore.setState({ ...EMPTY_MAPS, sessionsByBranch: new Map([[branch.branch_id, sessions]]) });
});
afterEach(() => {
  cleanup();
  agorStore.setState({ ...EMPTY_MAPS });
});

// Exercise the actual tree callers, not replicas of their row styling.
for (const surface of ['shared', 'branch-card', 'teammate'] as const) {
  for (const mode of ['light', 'dark'] as const) {
    it(`${surface}: ${mode} selection follows the row without moving layout or replacing focus`, async () => {
      const config = {
        algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { motion: false },
      };
      const token = theme.getDesignToken(config);
      function Fixture() {
        const [selectedSessionId, onSessionClick] = useState<string | null>('child');
        const props = { selectedSessionId, onSessionClick, client: null };
        return (
          <ConnectionProvider
            value={{
              connected: true,
              connecting: false,
              authGeneration: 0,
              outOfSync: false,
              capturedSha: null,
              currentSha: null,
            }}
          >
            <ConfigProvider theme={config}>
              <App style={{ background: token.colorBgContainer, minHeight: '100vh', padding: 8 }}>
                <div data-testid="surface" style={{ width: '100%', maxWidth: 420, height: 480 }}>
                  {surface === 'teammate' ? (
                    <BoardTeammatePanel
                      {...props}
                      board={{ board_id: 'selection-board' } as Board}
                      primaryTeammateBranch={branch}
                      primaryTeammateRepo={repo}
                      primaryTeammateInaccessible={false}
                    />
                  ) : surface === 'branch-card' ? (
                    <BranchCard
                      panelMode
                      {...props}
                      branch={branch}
                      repo={repo}
                      sessions={sessions}
                      userById={new Map()}
                    />
                  ) : (
                    <BranchSessionSections
                      {...props}
                      branch={branch}
                      sessions={sessions}
                      userById={new Map()}
                      mode="panel"
                    />
                  )}
                </div>
                <button type="button" onClick={() => onSessionClick(null)}>
                  Clear selection
                </button>
              </App>
            </ConfigProvider>
          </ConnectionProvider>
        );
      }
      render(<Fixture />);
      const rows = await Promise.all(
        sessions.map((session) =>
          screen.findByRole('button', { name: new RegExp(`^Open session ${session.title}`) })
        )
      );
      const geometry = () =>
        rows.map((row) => {
          const { x, y, width, height } = row.getBoundingClientRect();
          // Page scrolling to controls in short viewports is not a layout shift.
          const host = screen.getByTestId('surface').getBoundingClientRect();
          return { x: x - host.x, y: y - host.y, width, height };
        });
      const initial = geometry();
      const expectSelection = (index: number) => {
        for (const [i, row] of rows.entries()) {
          const style = getComputedStyle(row);
          expect(style.boxShadow.includes('inset')).toBe(i === index);
          if (i === index) {
            expect(style.boxShadow.replace(/\s/g, '')).toContain(
              token.colorText.replace(/\s/g, '')
            );
          }
          expect(style.borderRadius).toBe(`${token.borderRadiusSM}px`);
          expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
          expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
            screen.getByTestId('surface').getBoundingClientRect().right
          );
        }
        expect(geometry()).toEqual(initial);
      };
      expectSelection(1);
      const selectedFill = getComputedStyle(rows[1]).backgroundColor;
      expect(within(rows[1]).getByRole('img', { name: 'Latest task failed' })).toBeVisible();
      expect(within(rows[2]).getByRole('img', { name: 'Running' })).toBeVisible();
      await page.screenshot({
        path: `./.vitest/selection-${surface}-${mode}-${window.innerWidth}.png`,
      });

      await act(async () => page.elementLocator(rows[0]).click());
      expectSelection(0); // Parent border must not enclose its descendants.
      expect(getComputedStyle(rows[1]).backgroundColor).not.toBe(selectedFill);
      await act(async () => page.elementLocator(rows[2]).click());
      expectSelection(2); // Memoized rows must not retain a stale border.
      await act(async () => page.elementLocator(rows[1]).click());
      expectSelection(1);
      expect(getComputedStyle(rows[1]).backgroundColor).toBe(selectedFill);

      // Keyboard focus remains an independent native outline, not the selection border.
      await act(async () => userEvent.keyboard('{Tab}'));
      act(() => rows[1].focus());
      expect(rows[1].matches(':focus-visible')).toBe(true);
      expect(getComputedStyle(rows[1]).outlineStyle).not.toBe('none');
      expectSelection(1);
      await page.screenshot({
        path: `./.vitest/selection-focus-${surface}-${mode}-${window.innerWidth}.png`,
      });
      await act(async () => page.getByRole('button', { name: 'Clear selection' }).click());
      expectSelection(-1);
    });
  }
}
