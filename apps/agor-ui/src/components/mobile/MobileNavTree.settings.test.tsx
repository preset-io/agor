import type { User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileNavTree } from './MobileNavTree';

describe('MobileNavTree settings navigation', () => {
  it('exposes every desktop workspace settings subsection to admins', () => {
    const onOpenWorkspaceSettings = vi.fn();
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
  });
});
