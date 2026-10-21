import type { BoardFileItem, Branch, UserID } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardViewContext, type BoardViewContextValue } from '../../contexts/BoardViewContext';
import type { BoardPreviewState } from '../../hooks/useBoardPreview';
import { assignWorkToTasks } from '../../hooks/useSessionWork';
import { agorStore } from '../../store/agorStore';
import { SessionWorkContext, TaskWorkCards, WorkCard } from './WorkCard';

vi.mock('../BoardPreview/BranchDetailsPreview', () => ({
  branchPreviewStatus: (branch: Branch) =>
    branch.pull_request_url ? 'Ready to review' : branch.app_url ? 'Live' : undefined,
}));

const item = (overrides: Partial<BoardFileItem> = {}): BoardFileItem => ({
  kind: 'artifact',
  id: 'artifact-1',
  name: 'Northwind dashboard',
  made_at: '2026-10-21T10:05:00.000Z',
  made_by: { user_id: 'user-1' as UserID },
  source: { session_id: 'session-1', title: 'QBR prep' } as BoardFileItem['source'],
  status: 'Live',
  ...overrides,
});

function boardView(overrides: Partial<BoardViewContextValue> = {}): BoardViewContextValue {
  return {
    view: 'chat',
    showOnBoard: vi.fn(),
    preview: null,
    openPreview: vi.fn(),
    closePreview: vi.fn(),
    openConversation: vi.fn(),
    ...overrides,
  };
}

const renderCard = (card: BoardFileItem, context: BoardViewContextValue) =>
  render(
    <BoardViewContext.Provider value={context}>
      <WorkCard item={card} sessionId="session-1" />
    </BoardViewContext.Provider>
  );

afterEach(cleanup);

describe('assignWorkToTasks', () => {
  const tasks = [
    { task_id: 't1', created_at: '2026-10-21T10:00:00.000Z' },
    { task_id: 't2', created_at: '2026-10-21T11:00:00.000Z' },
  ];
  const at = (id: string, made_at: string) => item({ id, made_at });

  it('puts each item after the last turn that started before it was made', () => {
    const placed = assignWorkToTasks(
      [
        at('before', '2026-10-21T09:00:00.000Z'),
        at('between', '2026-10-21T10:30:00.000Z'),
        at('after', '2026-10-21T12:00:00.000Z'),
      ],
      tasks
    );
    expect(placed.get('t1')?.map((entry) => entry.id)).toEqual(['before', 'between']);
    expect(placed.get('t2')?.map((entry) => entry.id)).toEqual(['after']);
  });

  it('leaves items older than the loaded turns out while older turns are unloaded', () => {
    const placed = assignWorkToTasks([at('before', '2026-10-21T09:00:00.000Z')], tasks, {
      hasOlderTasks: true,
    });
    expect(placed.size).toBe(0);
    expect(assignWorkToTasks([at('x', '2026-10-21T09:00:00.000Z')], []).size).toBe(0);
  });
});

describe('WorkCard', () => {
  it('opens in the preview from Chat, and reads Showing while it is shown', () => {
    const context = boardView();
    const { unmount } = renderCard(item(), context);
    expect(screen.getByText('Artifact · Live')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(context.openPreview).toHaveBeenCalledWith({
      kind: 'artifact',
      id: 'artifact-1',
      item: item(),
    });
    unmount();

    const preview: BoardPreviewState = {
      target: { kind: 'artifact', id: 'artifact-1' as never, item: item() },
      fullScreen: false,
      openId: 1,
    };
    renderCard(item(), boardView({ preview }));
    expect(screen.getByRole('button', { name: 'Showing' })).toBeDisabled();
  });

  it('shows artifacts and apps on the board from Board; documents still open, in Chat', () => {
    const context = boardView({ view: 'board' });
    const { unmount } = renderCard(item(), context);
    fireEvent.click(screen.getByRole('button', { name: /Show on board/ }));
    expect(context.showOnBoard).toHaveBeenCalledWith('artifact-1', 'artifact');
    unmount();

    const app = renderCard(
      item({ kind: 'app', id: 'branch-1', status: 'Ready to review' }),
      context
    );
    fireEvent.click(screen.getByRole('button', { name: /Show on board/ }));
    expect(context.showOnBoard).toHaveBeenCalledWith('branch-1', 'branch');
    app.unmount();

    renderCard(item({ kind: 'document', id: 'doc-1', status: 'Draft' }), context);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(context.openPreview).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'document', id: 'doc-1' })
    );
    expect(context.openConversation).toHaveBeenCalledWith('session-1');
  });

  it('greys an archived item, says it is no longer available and explains the disabled action', async () => {
    renderCard(item({ archived: true }), boardView());
    expect(screen.getByText('Artifact · No longer available')).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Open' });
    expect(open).toBeDisabled();
    fireEvent.mouseEnter(open.parentElement as HTMLElement);
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(await screen.findByText('This artifact was archived.')).toBeInTheDocument();
  });
});

describe('TaskWorkCards', () => {
  const branch = {
    branch_id: 'branch-1',
    name: 'renewal-tracker',
    created_by: 'user-1',
    updated_at: '2026-10-21T12:00:00.000Z',
    pull_request_url: 'https://github.com/acme/app/pull/14',
  } as unknown as Branch;

  beforeEach(() => {
    agorStore.setState({ branchById: new Map([[branch.branch_id, branch]]) } as never);
  });

  const renderTask = (taskId: string, byTask: Map<string, BoardFileItem[]>) =>
    render(
      <BoardViewContext.Provider value={boardView()}>
        <SessionWorkContext.Provider
          value={{ sessionId: 'session-1', byTask, latestTaskId: 't2', branchId: 'branch-1' }}
        >
          <TaskWorkCards taskId={taskId} />
        </SessionWorkContext.Provider>
      </BoardViewContext.Provider>
    );

  it('shows the turn’s live and archived work; a deleted item has no row, so no card', () => {
    // The read returns live and archived items only; a hard-deleted one is simply absent.
    renderTask(
      't1',
      new Map([['t1', [item(), item({ id: 'old', name: 'Old chart', archived: true })]]])
    );
    expect(screen.getByText('Northwind dashboard')).toBeInTheDocument();
    expect(screen.getByText('Old chart')).toBeInTheDocument();
    expect(screen.queryByText('Deleted chart')).toBeNull();
    // The app and pull request card sits after the latest turn only.
    expect(screen.queryByText('renewal-tracker')).toBeNull();
  });

  it('adds the branch’s app and pull request after the latest turn', () => {
    renderTask('t2', new Map());
    expect(screen.getByText('renewal-tracker')).toBeInTheDocument();
    expect(screen.getByText('App and pull request · Ready to review')).toBeInTheDocument();
  });

  it('renders nothing for a turn without work', () => {
    const { container } = renderTask('t1', new Map());
    expect(container.querySelector('[data-work-cards]')).toBeNull();
  });
});
