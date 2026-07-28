import type { Board } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { App as AntApp, theme } from 'antd';
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

    expect(screen.getByRole('tab', { name: /Comments/ })).toHaveAttribute('aria-selected', 'true');
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it('shows unread activity on the Comments tab while the panel is expanded', () => {
    renderPanel({ unreadCommentsCount: 3 });

    expect(screen.getByRole('tab', { name: /Comments/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('3').closest('.ant-badge-count')).not.toBeNull();
  });

  it('uses mention emphasis for unread comments that mention the current user', () => {
    renderPanel({ unreadCommentsCount: 1, hasUserMentions: true });

    expect(screen.getByText('1').closest('.ant-badge-count')).toHaveStyle({
      backgroundColor: theme.getDesignToken().colorError,
    });
  });
});
