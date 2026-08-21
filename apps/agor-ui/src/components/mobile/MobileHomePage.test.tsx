import type { Board, Branch, Session, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileHomePage } from './MobileHomePage';

describe('MobileHomePage', () => {
  it('shows workspace actions, stats, sessions, boards, knowledge, and setup', () => {
    const onOpenSettings = vi.fn();
    render(
      <MemoryRouter>
        <MobileHomePage
          user={{ user_id: 'user-1', name: 'Amin' } as User}
          boardById={
            new Map([
              ['board-1', { board_id: 'board-1', name: 'Shipping', archived: false } as Board],
            ])
          }
          branchById={
            new Map([
              [
                'branch-1',
                {
                  branch_id: 'branch-1',
                  board_id: 'board-1',
                  name: 'feat/mobile',
                  archived: false,
                } as Branch,
              ],
            ])
          }
          sessionById={
            new Map([
              [
                'session-1',
                {
                  session_id: 'session-1',
                  branch_id: 'branch-1',
                  created_by: 'user-1',
                  title: 'Mobile polish',
                  status: 'running',
                  last_updated: '2026-08-14T00:00:00Z',
                  archived: false,
                } as Session,
              ],
            ])
          }
          onMenuClick={vi.fn()}
          onOpenSettings={onOpenSettings}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Hi, Amin! 👋')).toBeInTheDocument();
    expect(screen.getByText('Mobile polish')).toBeInTheDocument();
    expect(screen.getByText('Shipping')).toBeInTheDocument();
    expect(screen.getByText('Knowledge Base')).toBeInTheDocument();
    expect(screen.getByText('Workspace setup')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New board/ }));
    expect(onOpenSettings).toHaveBeenCalledWith('boards');
    fireEvent.click(screen.getByRole('button', { name: /Configure MCP tools/ }));
    expect(onOpenSettings).toHaveBeenCalledWith('mcp');
  });
});
