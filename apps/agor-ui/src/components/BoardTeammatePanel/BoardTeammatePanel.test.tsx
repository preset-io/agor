import type { Board } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BoardTeammatePanel } from './BoardTeammatePanel';

const board = { board_id: 'board-1' } as Board;

const renderPanel = (props: Partial<ComponentProps<typeof BoardTeammatePanel>> = {}) =>
  render(
    <AntApp>
      <BoardTeammatePanel
        board={board}
        activeTab="comments"
        onTabChange={vi.fn()}
        primaryTeammateInaccessible={false}
        onSessionClick={vi.fn()}
        client={null}
        {...props}
      />
    </AntApp>
  );

describe('BoardTeammatePanel controlled tabs', () => {
  it('does not reset a controlled Comments tab to the default tab on mount', () => {
    const onTabChange = vi.fn();

    renderPanel({ onTabChange });

    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveAttribute('aria-selected', 'true');
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

describe('BoardTeammatePanel empty state', () => {
  it('renders a Create teammate button when onCreateTeammate is provided', () => {
    const onCreateTeammate = vi.fn();

    renderPanel({ activeTab: 'teammate', onCreateTeammate });

    expect(screen.getByRole('button', { name: /create teammate/i })).toBeInTheDocument();
  });

  it('calls onCreateTeammate when the Create teammate button is clicked', () => {
    const onCreateTeammate = vi.fn();

    renderPanel({ activeTab: 'teammate', onCreateTeammate });

    fireEvent.click(screen.getByRole('button', { name: /create teammate/i }));
    expect(onCreateTeammate).toHaveBeenCalledOnce();
  });

  it('does not render a Create teammate button when onCreateTeammate is absent', () => {
    renderPanel({ activeTab: 'teammate' });

    expect(screen.queryByRole('button', { name: /create teammate/i })).not.toBeInTheDocument();
  });
});
