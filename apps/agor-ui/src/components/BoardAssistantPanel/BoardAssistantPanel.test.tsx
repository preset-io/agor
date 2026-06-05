import type { Board } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BoardAssistantPanel } from './BoardAssistantPanel';

const board = { board_id: 'board-1' } as Board;

const renderPanel = (props: Partial<ComponentProps<typeof BoardAssistantPanel>> = {}) =>
  render(
    <AntApp>
      <BoardAssistantPanel
        board={board}
        activeTab="comments"
        onTabChange={vi.fn()}
        primaryAssistantInaccessible={false}
        sessionsByBranch={new Map()}
        branchById={new Map()}
        repoById={new Map()}
        userById={new Map()}
        onSessionClick={vi.fn()}
        client={null}
        {...props}
      />
    </AntApp>
  );

describe('BoardAssistantPanel controlled tabs', () => {
  it('does not reset a controlled Comments tab to the default tab on mount', () => {
    const onTabChange = vi.fn();

    renderPanel({ onTabChange });

    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveAttribute('aria-selected', 'true');
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
