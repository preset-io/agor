import type {
  Artifact,
  Board,
  BoardEntityObject,
  Branch,
  CardWithType,
  Repo,
  Session,
} from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileBoardPage } from './MobileBoardPage';

vi.mock('../MarkdownRenderer/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

const board = {
  board_id: 'board-1',
  name: 'Delivery board',
  description: 'Everything shipping this week',
  objects: {
    zone: {
      type: 'zone',
      x: 0,
      y: 0,
      width: 500,
      height: 500,
      label: 'Review',
      status: 'In progress',
      trigger: { template: 'Review {{ branch.name }}', behavior: 'always_new' },
    },
    text: { type: 'text', x: 10, y: 10, content: 'Ship by Friday' },
    markdown: { type: 'markdown', x: 20, y: 20, width: 300, content: '## Checklist' },
    app: {
      type: 'app',
      x: 30,
      y: 30,
      width: 600,
      height: 400,
      title: 'Release dashboard',
      template: 'react',
      files: { '/App.tsx': 'export default function App() {}' },
    },
    artifact: {
      type: 'artifact',
      x: 40,
      y: 40,
      width: 600,
      height: 400,
      artifact_id: 'artifact-1',
    },
  },
} as unknown as Board;

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  repo_id: 'repo-1',
  name: 'feat/mobile',
  filesystem_status: 'ready',
} as unknown as Branch;

const placements = [
  {
    object_id: 'branch-placement',
    board_id: 'board-1',
    entity_type: 'branch',
    branch_id: 'branch-1',
    position: { x: 100, y: 100 },
    zone_id: 'zone',
  },
  {
    object_id: 'card-placement',
    board_id: 'board-1',
    entity_type: 'card',
    card_id: 'card-1',
    position: { x: 200, y: 100 },
    zone_id: 'zone',
  },
] as unknown as BoardEntityObject[];

describe('MobileBoardPage', () => {
  it('represents every supported board object and entity type', () => {
    render(
      <MemoryRouter initialEntries={['/m/board/board-1']}>
        <Routes>
          <Route
            path="/m/board/:boardId"
            element={
              <MobileBoardPage
                boardById={new Map([['board-1', board]])}
                branchById={new Map([['branch-1', branch]])}
                repoById={
                  new Map([['repo-1', { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo]])
                }
                sessionsByBranch={
                  new Map([
                    [
                      'branch-1',
                      [
                        {
                          session_id: 'session-1',
                          title: 'Polish mobile UI',
                          status: 'running',
                          last_updated: '2026-08-14T00:00:00Z',
                          agentic_tool: 'codex',
                        } as Session,
                      ],
                    ],
                  ])
                }
                boardObjectsByBoardId={new Map([['board-1', placements]])}
                cardById={
                  new Map([
                    [
                      'card-1',
                      {
                        card_id: 'card-1',
                        title: 'Customer ticket',
                        note: 'Waiting on review',
                        data: { priority: 'high' },
                        effective_emoji: '🎫',
                        archived: false,
                      } as CardWithType,
                    ],
                  ])
                }
                artifactById={
                  new Map([
                    [
                      'artifact-1',
                      {
                        artifact_id: 'artifact-1',
                        name: 'Deploy preview',
                        template: 'react',
                        build_status: 'success',
                        fullscreen_url: '/ui/a/artifact-1/fullscreen',
                      } as Artifact,
                    ],
                  ])
                }
                onMenuClick={vi.fn()}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getAllByText('Review')).toHaveLength(3);
    expect(screen.getByText('Ship by Friday')).toBeInTheDocument();
    expect(screen.getByText('## Checklist')).toBeInTheDocument();
    expect(screen.getByText('Release dashboard')).toBeInTheDocument();
    expect(screen.getByText('Deploy preview')).toBeInTheDocument();
    expect(screen.getByText('Customer ticket')).toBeInTheDocument();
    expect(screen.getByText('feat/mobile')).toBeInTheDocument();
    expect(screen.getByText('Polish mobile UI')).toBeInTheDocument();
  });
});
