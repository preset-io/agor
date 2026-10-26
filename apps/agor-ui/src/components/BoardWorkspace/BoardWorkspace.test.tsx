import type { Board, Branch } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App } from 'antd';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardWorkspace } from './BoardWorkspace';

vi.mock('./BoardTreeNavigator', () => ({
  BoardComments: () => <div>Board discussion</div>,
  BoardTreeNavigator: ({
    onContentClick,
    actions,
  }: {
    onContentClick: (v: { kind: 'object'; id: string }) => void;
    actions: { onSessionClick: (id: string) => void };
  }) => (
    <>
      <button type="button" onClick={() => onContentClick({ kind: 'object', id: 'note' })}>
        Open note
      </button>
      <button type="button" onClick={() => actions.onSessionClick('already-selected')}>
        Select session
      </button>
    </>
  ),
}));
vi.mock('./BoardContent', () => ({
  BoardContentDetail: ({ onClose }: { onClose: () => void }) => (
    <div>
      Note content
      <button type="button" onClick={onClose}>
        Close content
      </button>
    </div>
  ),
}));
vi.mock('../BranchCard', () => ({ default: () => <div>Branch details</div> }));
vi.mock('../../hooks/useAppNavigation', () => ({
  useAppNavigation: () => ({ goToBranch: vi.fn(), goToBoard: vi.fn(), goToArtifact: vi.fn() }),
}));
const board = { board_id: 'one', name: 'Board', objects: {} } as Board;
function Conversation() {
  const [draft, setDraft] = useState('');
  return <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />;
}
function View({ compact = false, selected = true }: { compact?: boolean; selected?: boolean }) {
  return (
    <MemoryRouter>
      <App>
        <BoardWorkspace
          board={board}
          branches={[] as Branch[]}
          actions={{
            client: null,
            board,
            currentUserId: 'viewer',
            onSessionClick: vi.fn(),
            primaryTeammateInaccessible: false,
            boardReady: true,
          }}
          canvas={<div>Spatial canvas</div>}
          conversation={<Conversation />}
          conversationOpen={selected}
          compact={compact}
        />
      </App>
    </MemoryRouter>
  );
}
beforeEach(() => localStorage.clear());
describe('alternative board views', () => {
  it('starts with tree, lazily mounts canvas, keeps draft through switching and content selection', () => {
    render(<View />);
    expect(screen.queryByText('Spatial canvas')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Unsent prompt' } });
    const input = screen.getByLabelText('Draft');
    fireEvent.click(screen.getByRole('radio', { name: 'Board', exact: true }));
    expect(screen.getByText('Spatial canvas')).toBeVisible();
    expect(screen.getByLabelText('Board navigator')).not.toBeVisible();
    expect(screen.getByLabelText('Draft')).toBe(input);
    fireEvent.click(screen.getByRole('radio', { name: 'Tree', exact: true }));
    expect(screen.getByText('Spatial canvas')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open note' }));
    expect(screen.getByText('Note content')).toBeVisible();
    expect(screen.getByLabelText('Draft')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close content' }));
    expect(screen.getByLabelText('Draft')).toHaveValue('Unsent prompt');
  });
  it('reveals the conversation when selecting its existing URL from content', () => {
    render(<View />);
    const draft = screen.getByLabelText('Draft');
    fireEvent.click(screen.getByRole('button', { name: 'Open note' }));
    expect(draft).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Select session' }));
    expect(draft).toBeVisible();
    expect(screen.queryByText('Note content')).not.toBeInTheDocument();
  });
  it('uses sequential navigation on compact screens without an empty conversation pane', () => {
    render(<View compact selected={false} />);
    expect(screen.getByLabelText('Board navigator')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Board detail' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open note' }));
    expect(screen.getByLabelText('Board navigator')).not.toBeVisible();
    expect(screen.getByText('Note content')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close content' }));
    expect(screen.getByLabelText('Board navigator')).toBeVisible();
  });
});
