import type { Board } from '@agor-live/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { BoardSwitcher } from './BoardSwitcher';

vi.mock('../BoardEditModal', () => ({ BoardEditModal: () => null }));

describe('BoardSwitcher keyboard disclosure', () => {
  it('reveals a clipped board name without hover and hides it when focus leaves', async () => {
    const name = `Board-${'long-name-'.repeat(30)}`;
    const board = { board_id: 'board-1', name } as Board;
    const { container } = render(
      <BoardSwitcher
        boards={[board]}
        currentBoardId={board.board_id}
        onBoardChange={vi.fn()}
        branchById={new Map()}
      />
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.ant-dropdown-trigger')!;
    await userEvent.click(trigger);
    const item = await screen.findByRole('menuitem');
    const label = item.querySelector<HTMLElement>('[data-board-name]')!;
    await waitFor(() => expect(label.scrollWidth).toBeGreaterThan(label.clientWidth));
    act(() => item.focus());
    expect(item).toHaveFocus();
    expect(label).not.toHaveAttribute('tabindex');
    expect(await screen.findByRole('tooltip')).toHaveTextContent(name);
    act(() => trigger.focus());
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});
