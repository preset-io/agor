import type { Board, Branch, Link, Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BRANCH_MODAL_TAB } from '../BranchModal/branchModalConstants';
import { makeTestLink } from '../Links/testUtils';
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

  it('opens the teammate links tab from the pinned-links gear', () => {
    const pinned = makeTestLink({
      branch_id: primaryTeammateBranch.branch_id,
      session_id: null,
      is_pinned: true,
      title: 'Teammate runbook',
      url: 'https://example.com/teammate-runbook',
    });
    agorStore.setState({
      ...EMPTY_MAPS,
      linksByBranch: new Map([[primaryTeammateBranch.branch_id, [pinned]]]),
      linkById: new Map([[pinned.link_id, pinned as Link]]),
      fullBranchLinkOwnerIds: new Set([primaryTeammateBranch.branch_id]),
    });
    const onOpenSettings = vi.fn();

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
          onOpenSettings={onOpenSettings}
          client={null}
        />
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Manage links' }));

    expect(onOpenSettings).toHaveBeenCalledWith(
      primaryTeammateBranch.branch_id,
      BRANCH_MODAL_TAB.links
    );
  });
});
