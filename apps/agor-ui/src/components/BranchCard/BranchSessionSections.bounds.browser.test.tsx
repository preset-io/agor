import type { Branch, Session } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      <div style={{ width: 280 }}>
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
      expect(scroller!.getBoundingClientRect().height).toBeLessThanOrEqual(400);
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
