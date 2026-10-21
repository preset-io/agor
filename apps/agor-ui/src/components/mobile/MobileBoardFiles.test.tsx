import type { AgorClient, Board, BoardFileItem, Branch, UserID } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { MobileBoardFilesPage } from './MobileBoardFilesPage';
import { MobileBoardPage, mobileDefaultBoardTab } from './MobileBoardPage';

vi.mock('../SessionCanvas/SessionCanvas', () => ({ default: () => <div data-testid="canvas" /> }));
vi.mock('../CommentsPanel', () => ({ CommentsPanel: () => null }));
vi.mock('../BoardEditModal/BoardEditModal', () => ({
  BoardEditModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Board settings dialog" /> : null,
}));
vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
  UploadAttachmentLink: () => null,
}));
const manage = { can: false };
vi.mock('../../hooks/useCanManageBoard', () => ({ useCanManageBoard: () => manage.can }));

const board = { board_id: 'board-1', name: 'Delivery', objects: {} } as unknown as Board;
const boardById = new Map([[board.board_id, board]]);
const branchById = new Map<string, Branch>();

const doc: BoardFileItem = {
  kind: 'document',
  id: 'doc-1',
  name: 'Talking points',
  made_at: '2026-10-21T10:00:00.000Z',
  made_by: { user_id: 'user-1' as UserID },
  source: { session_id: 'session-1', title: 'QBR prep' } as BoardFileItem['source'],
  status: 'Shared',
};
const client = {
  service: vi.fn(() => ({
    find: vi.fn(async () => ({ total: 1, limit: 50, skip: 0, data: [doc] })),
    get: vi.fn(async () => ({ content: 'Wins first.' })),
    on: vi.fn(),
    removeListener: vi.fn(),
  })),
} as unknown as AgorClient;

function Probe() {
  const { pathname } = useLocation();
  return <output aria-label="location">{pathname}</output>;
}

function renderAt(entry: string) {
  render(
    <App>
      <MemoryRouter initialEntries={[entry]}>
        <Probe />
        <Routes>
          <Route
            path="/m/board/:boardId"
            element={
              <MobileBoardPage
                client={null}
                boardById={boardById}
                branchById={branchById}
                onOpenBranch={vi.fn()}
                onNewSession={vi.fn()}
                onForkSession={vi.fn(async () => {})}
                onSpawnSession={vi.fn(async () => {})}
                onSendComment={vi.fn()}
                settingsHydrated
              />
            }
          />
          <Route
            path="/m/board/:boardId/files"
            element={<MobileBoardFilesPage client={client} boardById={boardById} />}
          />
          <Route path="/m/session/:sessionId" element={<div>Session page</div>} />
        </Routes>
      </MemoryRouter>
    </App>
  );
}

const location = () => screen.getByRole('status', { name: 'location' }).textContent;

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More board actions' }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  manage.can = false;
  agorStore.setState({ ...EMPTY_MAPS, boardById, branchById } as never);
});
afterEach(cleanup);

describe('mobile board ⋯ menu', () => {
  it('offers Files to everyone, and Board settings only to editors', async () => {
    renderAt('/m/board/board-1');
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /Files/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Board settings/ })).toBeNull();
    cleanup();

    manage.can = true;
    renderAt('/m/board/board-1');
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Board settings/ }));
    expect(
      await screen.findByRole('dialog', { name: 'Board settings dialog' })
    ).toBeInTheDocument();
  });

  it('opens Files as its own page, so the phone’s Back works', async () => {
    renderAt('/m/board/board-1');
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Files/ }));
    expect(location()).toBe('/m/board/board-1/files');
    expect(screen.getByRole('heading', { name: 'Files' })).toBeInTheDocument();
  });
});

describe('mobile Files page', () => {
  it('has only Search and Type, opens items in a sheet, and goes to the conversation', async () => {
    renderAt('/m/board/board-1/files');
    expect(screen.getByLabelText('Search files')).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sort')).toBeNull();
    expect(screen.queryByLabelText('View')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Talking points, Document' }));
    expect(await screen.findByText('Wins first.')).toBeInTheDocument();
    expect(screen.getByText('Document · Shared')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open conversation/ }));
    expect(location()).toBe('/m/session/session-1');
  });
});

describe('mobileDefaultBoardTab', () => {
  it('keeps Teammate unless an editor stored an order with Board first', () => {
    expect(mobileDefaultBoardTab(undefined)).toBe('teammate');
    expect(mobileDefaultBoardTab({})).toBe('teammate');
    expect(mobileDefaultBoardTab({ tab_order: ['chat', 'board', 'files'] })).toBe('teammate');
    expect(mobileDefaultBoardTab({ tab_order: ['board', 'chat', 'files'] })).toBe('board');
  });
});
