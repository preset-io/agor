import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import type { BoardWriteTicket } from '../../../store/boardMutationGuard';
import { MarkdownNode } from './MarkdownNode';

const CONNECTED = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const openConfirmations = () => document.querySelectorAll('.ant-modal-confirm').length;

afterEach(async () => {
  cleanup();
  await waitFor(() => expect(openConfirmations()).toBe(0));
});

describe('MarkdownNode delete confirmation', () => {
  function setup() {
    const ticket = { boardId: 'board-1' } as BoardWriteTicket;
    const onDelete = vi.fn();
    const beginBoardWrite = vi.fn(() => ticket);
    const ui = (show: boolean) => (
      <AntApp>
        <ConnectionProvider value={CONNECTED}>
          {show && (
            <MarkdownNode
              data={{
                objectId: 'markdown-1',
                content: 'A note',
                width: 300,
                canEdit: true,
                onUpdate: vi.fn(),
                onDelete,
                beginBoardWrite,
              }}
            />
          )}
        </ConnectionProvider>
      </AntApp>
    );
    const view = render(ui(true));
    return { view, ui, onDelete, beginBoardWrite, ticket };
  }

  it('a double click opens one confirmation, and removing the node ends it', async () => {
    const { view, ui, onDelete, beginBoardWrite } = setup();
    const deleteButton = screen.getByRole('button', { name: 'Delete note' });
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(openConfirmations()).toBeGreaterThan(0));
    expect(openConfirmations()).toBe(1);
    expect(beginBoardWrite).toHaveBeenCalledTimes(1);
    const okButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.ant-modal-confirm-btns .ant-btn-dangerous')
    );
    view.rerender(ui(false));
    await waitFor(() => expect(openConfirmations()).toBe(0));
    for (const ok of okButtons) {
      await act(async () => {
        fireEvent.click(ok);
      });
    }
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('a cancelled confirmation lets the next click open one, which deletes once', async () => {
    const { onDelete, ticket } = setup();
    const deleteButton = screen.getByRole('button', { name: 'Delete note' });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(openConfirmations()).toBe(1));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await waitFor(() => expect(openConfirmations()).toBe(0));
    fireEvent.click(deleteButton);
    await waitFor(() => expect(openConfirmations()).toBe(1));
    await act(async () => {
      fireEvent.click(
        document.querySelector('.ant-modal-confirm-btns .ant-btn-dangerous') as HTMLButtonElement
      );
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('markdown-1', ticket);
  });
});
