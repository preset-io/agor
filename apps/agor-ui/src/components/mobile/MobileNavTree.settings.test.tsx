import type { Board, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileNavTree } from './MobileNavTree';

describe('MobileNavTree settings navigation', () => {
  it('names both compact board destinations for assistive technology', () => {
    render(
      <MemoryRouter>
        <MobileNavTree
          boardById={new Map([['board-1', { board_id: 'board-1', name: 'Delivery' } as Board]])}
          branchById={new Map()}
          sessionsByBranch={new Map()}
          commentById={new Map()}
          onOpenWorkspaceSettings={vi.fn()}
          onOpenUserSettings={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: 'Open Delivery board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open comments for Delivery' })).toBeInTheDocument();
  });

  it('exposes every desktop workspace settings subsection to admins', () => {
    const onOpenWorkspaceSettings = vi.fn();
    const onNavigate = vi.fn();
    render(
      <MemoryRouter>
        <MobileNavTree
          boardById={new Map()}
          branchById={new Map()}
          sessionsByBranch={new Map()}
          commentById={new Map()}
          currentUser={{ role: 'admin' } as User}
          onOpenWorkspaceSettings={onOpenWorkspaceSettings}
          onOpenUserSettings={vi.fn()}
          onNavigate={onNavigate}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('Workspace settings'));
    for (const label of [
      'Boards',
      'Repositories',
      'Branches',
      'Teammates',
      'Cards (Beta)',
      'Artifacts',
      'Agentic Tools',
      'MCP Servers',
      'Gateway Channels',
      'Groups',
      'Users',
      'About',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByText('Gateway Channels'));
    expect(onOpenWorkspaceSettings).toHaveBeenCalledWith('gateway');
    expect(onNavigate).toHaveBeenCalled();
  });

  // MCP Servers is not admin-only on desktop: a member may read the tenant's
  // `mcp_member_policy` so a refusal is legible to the person it refuses.
  // Mobile navigation has to reach the same tab.
  it('offers MCP settings to members while still hiding admin-only sections', () => {
    const onOpenWorkspaceSettings = vi.fn();
    render(
      <MemoryRouter>
        <MobileNavTree
          boardById={new Map()}
          branchById={new Map()}
          sessionsByBranch={new Map()}
          commentById={new Map()}
          currentUser={{ role: 'member' } as User}
          onOpenWorkspaceSettings={onOpenWorkspaceSettings}
          onOpenUserSettings={vi.fn()}
          onNavigate={vi.fn()}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('Workspace settings'));
    for (const adminOnly of ['Agentic Tools', 'Gateway Channels', 'Groups']) {
      expect(screen.queryByText(adminOnly)).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByText('MCP Servers'));
    expect(onOpenWorkspaceSettings).toHaveBeenCalledWith('mcp');
  });
});
