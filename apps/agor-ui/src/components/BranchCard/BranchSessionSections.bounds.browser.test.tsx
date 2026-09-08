import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from '../BoardTeammatePanel/BoardTeammatePanel';
import { BranchSessionSections } from './BranchSessionSections';

const branch = { branch_id: 'branch-1', filesystem_status: 'ready' } as Branch;

function makeSession(index: number, overrides: Partial<Session> = {}): Session {
  return {
    session_id: `session-${index}`,
    branch_id: branch.branch_id,
    title: `Conversation ${index}`,
    agentic_tool: 'codex',
    status: 'idle',
    archived: false,
    created_at: '2026-09-01T00:00:00.000Z',
    last_updated: new Date(Date.UTC(2026, 8, 1) - index * 1000).toISOString(),
    genealogy: { children: [] },
    ...overrides,
  } as Session;
}

function mount(sessions: Session[], mode: 'card' | 'panel' = 'card') {
  const onSessionClick = vi.fn();
  const view = render(
    <App>
      <div style={{ width: 280, height: 600, display: 'flex', flexDirection: 'column' }}>
        <BranchSessionSections
          branch={branch}
          sessions={sessions}
          userById={new Map()}
          client={null}
          mode={mode}
          onSessionClick={onSessionClick}
        />
      </div>
    </App>
  );
  return { ...view, onSessionClick };
}

beforeEach(() => localStorage.clear());

describe('large branch session collections', () => {
  it('sizes the teammate tab from its actual panel, including the teammate header', async () => {
    const sessions = Array.from({ length: 1000 }, (_, index) => makeSession(index));
    agorStore.setState({
      ...EMPTY_MAPS,
      sessionsByBranch: new Map([[branch.branch_id, sessions]]),
    });
    const { container } = render(
      <App>
        <div data-testid="panel" style={{ width: 350, height: 1000 }}>
          <BoardTeammatePanel
            board={{ board_id: 'board-1', name: 'Board' } as Board}
            primaryTeammateBranch={branch}
            primaryTeammateRepo={{ repo_id: 'repo-1', slug: 'example/repo' } as Repo}
            primaryTeammateInaccessible={false}
            onSessionClick={vi.fn()}
            client={null}
          />
        </div>
      </App>
    );
    const panel = screen.getByTestId('panel');
    const scroller = () => container.querySelector<HTMLElement>('.ant-tree-list-holder')!;
    await waitFor(() => expect(scroller().clientHeight).toBeGreaterThan(700));
    panel.style.height = '400px';
    await waitFor(() => {
      expect(scroller().clientHeight).toBeGreaterThan(80);
      expect(scroller().clientHeight).toBeLessThan(250);
      expect(scroller().getBoundingClientRect().bottom).toBeLessThanOrEqual(
        panel.getBoundingClientRect().bottom
      );
    });
  });

  it('shares panel space across sections and releases it when a section is collapsed or filtered', async () => {
    const sessions = Array.from({ length: 1000 }, (_, index) =>
      makeSession(
        index,
        index >= 500
          ? {
              custom_context: {
                gateway_source: {
                  channel_id: 'channel-1',
                  channel_type: 'slack',
                  channel_name: 'Team',
                  thread_id: `thread-${index}`,
                },
              },
            }
          : {}
      )
    );
    const { container } = mount(sessions, 'panel');
    const scrollers = () =>
      Array.from(container.querySelectorAll<HTMLElement>('.ant-tree-list-holder'));
    await waitFor(() => {
      expect(scrollers()).toHaveLength(2);
      expect(
        scrollers().every((element) => element.clientHeight > 100 && element.clientHeight < 300)
      ).toBe(true);
    });
    fireEvent.click(screen.getByText('Sessions'));
    await waitFor(() => {
      expect(scrollers()).toHaveLength(1);
      expect(scrollers()[0].clientHeight).toBeGreaterThan(400);
    });
    fireEvent.change(screen.getByPlaceholderText('Search sessions...'), {
      target: { value: 'Conversation 999' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open session Conversation 999' })).toBeVisible()
    );
    fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: '' } });
    await waitFor(() => expect(scrollers()[0].clientHeight).toBeGreaterThan(400));
  });

  it('uses the panel height and responds to container resizing without mounting the whole tree', async () => {
    const { container } = mount(
      Array.from({ length: 1000 }, (_, index) => makeSession(index)),
      'panel'
    );
    const panel = container.querySelector<HTMLElement>('.ant-app > div')!;
    const scroller = () => container.querySelector<HTMLElement>('.ant-tree-list-holder')!;

    panel.style.height = '1000px';
    await waitFor(() => expect(scroller().clientHeight).toBeGreaterThan(800));
    expect(
      screen.getAllByRole('button', { name: /^Open session Conversation/ }).length
    ).toBeLessThan(60);

    panel.style.height = '350px';
    await waitFor(() => {
      expect(scroller().clientHeight).toBeGreaterThan(100);
      expect(scroller().clientHeight).toBeLessThan(300);
      expect(scroller().getBoundingClientRect().bottom).toBeLessThanOrEqual(
        panel.getBoundingClientRect().bottom
      );
    });
  });

  it.each(['card', 'panel'] as const)(
    'virtualizes expanded manual and gateway descendants in %s mode without hiding the tail',
    async (mode) => {
      const sessions = Array.from({ length: 1001 }, (_, index) =>
        makeSession(index, {
          genealogy: {
            children: [],
            ...(index > 0 ? { parent_session_id: 'session-0' as Session['session_id'] } : {}),
          },
          ...(mode === 'panel' && index === 0
            ? {
                custom_context: {
                  gateway_source: {
                    channel_id: 'channel-1',
                    channel_type: 'slack',
                    channel_name: 'Team',
                    thread_id: 'thread-1',
                  },
                },
              }
            : {}),
        })
      );
      const { container, onSessionClick } = mount(sessions, mode);
      await waitFor(() => {
        const rows = screen.getAllByRole('button', { name: /^Open session Conversation/ });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(40);
      });
      const scroller = container.querySelector<HTMLElement>('.ant-tree-list-holder');
      expect(scroller).not.toBeNull();
      expect(scroller!.getBoundingClientRect().height).toBeLessThanOrEqual(
        mode === 'card' ? 400 : 600
      );
      // Variable-height rows (two-line titles / gateway metadata) remain reachable.
      for (let attempt = 0; attempt < 10; attempt++) {
        await act(async () => {
          scroller!.scrollTop = scroller!.scrollHeight;
          fireEvent.scroll(scroller!);
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
      }
      expect(screen.getByRole('button', { name: 'Open session Conversation 1000' })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Open session Conversation 1000' }));
      expect(onSessionClick).toHaveBeenCalledWith('session-1000');
    }
  );

  it('paginates scheduled runs and broad search matches instead of mounting every row', async () => {
    const sessions = Array.from({ length: 1000 }, (_, index) =>
      makeSession(index, { scheduled_from_branch: true, scheduled_run_at: 1000 - index })
    );
    const { onSessionClick } = mount(sessions, 'panel');
    expect(screen.getAllByRole('button', { name: /^Open session Conversation/ })).toHaveLength(20);
    fireEvent.click(screen.getByTitle('Next Page'));
    fireEvent.click(screen.getByRole('button', { name: 'Open session Conversation 20' }));
    expect(onSessionClick).toHaveBeenCalledWith('session-20');
    fireEvent.change(screen.getByPlaceholderText('Search sessions...'), {
      target: { value: 'Conversation' },
    });
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Open session Conversation/ })).toHaveLength(
        20
      );
    });
  });
});
