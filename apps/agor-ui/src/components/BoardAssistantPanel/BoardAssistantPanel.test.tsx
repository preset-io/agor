import type { AgorClient, Board, Branch, Link, Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BoardAssistantPanel } from './BoardAssistantPanel';

const board = { board_id: 'board-1' } as Board;
const assistantBranch = {
  branch_id: 'assistant-1',
  repo_id: 'repo-1',
  name: 'assistant',
  custom_context: { assistant: { kind: 'assistant', displayName: 'Helper' } },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as Branch;
const assistantRepo = {
  repo_id: 'repo-1',
  slug: 'agor',
  name: 'Agor',
  repo_type: 'local',
} as Repo;

function makePinnedLink(index: number): Link {
  return {
    link_id: `link-${index}`,
    branch_id: assistantBranch.branch_id,
    session_id: null,
    title: `Link ${index}`,
    url: `https://example.com/${index}`,
    kind: 'url',
    source: 'manual',
    target_key: `url:https://example.com/${index}`,
    is_pinned: true,
    created_at: `2026-01-01T00:00:0${index}.000Z`,
    updated_at: `2026-01-01T00:00:0${index}.000Z`,
  } as Link;
}

function makeClient(links: Link[]): AgorClient {
  const linksService = {
    find: vi.fn().mockResolvedValue({ data: links }),
    patch: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    service: vi.fn((name: string) => {
      if (name === 'links') return linksService;
      throw new Error(`Unexpected service ${name}`);
    }),
  } as unknown as AgorClient;
}

const renderPanel = (props: Partial<ComponentProps<typeof BoardAssistantPanel>> = {}) =>
  render(
    <MemoryRouter>
      <AntApp>
        <BoardAssistantPanel
          board={board}
          activeTab="comments"
          onTabChange={vi.fn()}
          primaryAssistantInaccessible={false}
          onSessionClick={vi.fn()}
          client={null}
          {...props}
        />
      </AntApp>
    </MemoryRouter>
  );

const renderAssistantPanel = (
  links: Link[],
  props: Partial<ComponentProps<typeof BoardAssistantPanel>> = {}
) =>
  renderPanel({
    activeTab: 'assistant',
    primaryAssistantBranch: assistantBranch,
    primaryAssistantRepo: assistantRepo,
    client: makeClient(links),
    ...props,
  });

describe('BoardAssistantPanel controlled tabs', () => {
  it('does not reset a controlled Comments tab to the default tab on mount', () => {
    const onTabChange = vi.fn();

    renderPanel({ onTabChange });

    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveAttribute('aria-selected', 'true');
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

describe('BoardAssistantPanel assistant pinned links', () => {
  it('shows six pinned links inline without a more affordance at the limit', async () => {
    renderAssistantPanel(Array.from({ length: 6 }, (_, index) => makePinnedLink(index + 1)));

    expect(await screen.findByText('Link 1')).toBeInTheDocument();
    expect(screen.getByText('Link 6')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\+\d+ more/i })).not.toBeInTheDocument();
  });

  it('shows the hidden pinned link count above the inline limit', async () => {
    renderAssistantPanel(Array.from({ length: 8 }, (_, index) => makePinnedLink(index + 1)));

    expect(await screen.findByText('Link 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+2 more' })).toBeInTheDocument();
    expect(screen.queryByText('Link 7')).not.toBeInTheDocument();
    expect(screen.queryByText('Link 8')).not.toBeInTheDocument();
  });

  it('opens the assistant branch modal on the Links tab when clicking more', async () => {
    const onOpenSettings = vi.fn();
    renderAssistantPanel(
      Array.from({ length: 7 }, (_, index) => makePinnedLink(index + 1)),
      {
        onOpenSettings,
      }
    );

    fireEvent.click(await screen.findByRole('button', { name: '+1 more' }));

    await waitFor(() => {
      expect(onOpenSettings).toHaveBeenCalledWith(assistantBranch.branch_id, 'links');
    });
  });
});
