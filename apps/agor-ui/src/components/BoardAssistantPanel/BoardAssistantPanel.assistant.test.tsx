import type { Board, Branch, Repo } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardAssistantPanel } from './BoardAssistantPanel';

vi.mock('../BranchCard', () => ({
  BranchSessionSections: ({ defaultExpanded }: { defaultExpanded?: boolean }) => (
    <div data-testid="assistant-session-sections">defaultExpanded:{String(defaultExpanded)}</div>
  ),
}));

vi.mock('../BranchHeaderPill', () => ({
  BranchHeaderPill: () => <div data-testid="branch-header-pill" />,
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const primaryAssistantBranch = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'assistant',
  filesystem_status: 'ready',
} as Branch;
const primaryAssistantRepo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

describe('BoardAssistantPanel assistant tab', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('expands the assistant Sessions section by default', () => {
    render(
      <AntApp>
        <BoardAssistantPanel
          board={board}
          activeTab="assistant"
          onTabChange={vi.fn()}
          primaryAssistantBranch={primaryAssistantBranch}
          primaryAssistantRepo={primaryAssistantRepo}
          primaryAssistantInaccessible={false}
          onSessionClick={vi.fn()}
          client={null}
        />
      </AntApp>
    );

    expect(screen.getByTestId('assistant-session-sections')).toHaveTextContent(
      'defaultExpanded:true'
    );
  });
});
