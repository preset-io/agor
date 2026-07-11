import type { Board, Branch, Repo } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from './BoardTeammatePanel';

vi.mock('../BranchCard', () => ({
  BranchSessionSections: ({ defaultExpanded }: { defaultExpanded?: boolean }) => (
    <div data-testid="teammate-session-sections">defaultExpanded:{String(defaultExpanded)}</div>
  ),
}));

vi.mock('../BranchHeaderPill', () => ({
  BranchHeaderPill: ({ fluid }: { fluid?: boolean }) => (
    <div data-testid="branch-header-pill" data-fluid={String(fluid)} />
  ),
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const primaryTeammateBranch = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'teammate',
  filesystem_status: 'ready',
} as Branch;
const primaryTeammateRepo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

describe('BoardTeammatePanel teammate tab', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('expands the teammate Sessions section by default', () => {
    render(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateBranch={primaryTeammateBranch}
          primaryTeammateRepo={primaryTeammateRepo}
          primaryTeammateInaccessible={false}
          onSessionClick={vi.fn()}
          client={null}
        />
      </AntApp>
    );

    expect(screen.getByTestId('teammate-session-sections')).toHaveTextContent(
      'defaultExpanded:true'
    );
    expect(screen.getByTestId('branch-header-pill')).toHaveAttribute('data-fluid', 'true');
  });
});
