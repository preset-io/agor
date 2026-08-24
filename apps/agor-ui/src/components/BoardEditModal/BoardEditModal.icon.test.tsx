import type { AgorClient, Board } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { BoardEditModal } from './BoardEditModal';

vi.mock('@/utils/message', () => ({ useThemedMessage: () => ({ showError: vi.fn() }) }));
vi.mock('../JSONEditor', () => ({
  JSONEditor: () => <textarea aria-label="Custom Context (JSON)" />,
  validateJSON: () => Promise.resolve(),
}));
vi.mock('../EmojiPickerInput/AgorEmojiPickerInner', () => ({
  default: ({ onEmojiClick }: { onEmojiClick: (data: { emoji: string }) => void }) => (
    <button
      type="button"
      aria-label="Choose technologist"
      onClick={() => onEmojiClick({ emoji: '👩🏽‍💻' })}
    >
      technologist
    </button>
  ),
}));

const listedBoard = {
  board_id: 'board-1',
  name: 'Emoji board',
  created_by: 'owner-1',
  created_at: '',
  last_updated: '',
} as Board;

function makeClient(getBoard: () => Board): AgorClient {
  const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 404 }));
  return {
    service: (name: string) => {
      if (name === 'boards') return { get: vi.fn().mockImplementation(getBoard) };
      if (name === 'boards/:id/owners' || name === 'boards/:id/group-grants') {
        return { find: vi.fn(notFound) };
      }
      return { findAll: vi.fn().mockResolvedValue([]) };
    },
  } as unknown as AgorClient;
}

describe('BoardEditModal — board icon', () => {
  it('selects and persists a multi-codepoint emoji, then restores it on reopen', async () => {
    let savedBoard = { ...listedBoard, icon: '🚩' } as Board;
    const onUpdate = vi.fn(async (_id: string, updates: Partial<Board>) => {
      savedBoard = { ...savedBoard, ...updates };
    });
    const client = makeClient(() => savedBoard);
    const view = render(
      <AntApp>
        <BoardEditModal
          board={listedBoard}
          client={client}
          open
          onClose={vi.fn()}
          onUpdate={onUpdate}
        />
      </AntApp>
    );

    const trigger = await screen.findByRole('button', { name: 'Choose emoji' });
    expect(trigger).toHaveTextContent('🚩');
    fireEvent.click(trigger);
    const pickerButton = await screen.findByRole(
      'button',
      { name: 'Choose technologist' },
      { timeout: 10_000 }
    );
    fireEvent.click(pickerButton);
    expect(trigger).toHaveTextContent('👩🏽‍💻');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0]?.[1]).toMatchObject({ icon: '👩🏽‍💻' });

    view.rerender(
      <AntApp>
        <BoardEditModal
          board={listedBoard}
          client={client}
          open={false}
          onClose={vi.fn()}
          onUpdate={onUpdate}
        />
      </AntApp>
    );
    view.rerender(
      <AntApp>
        <BoardEditModal
          board={listedBoard}
          client={client}
          open
          onClose={vi.fn()}
          onUpdate={onUpdate}
        />
      </AntApp>
    );
    expect(await screen.findByRole('button', { name: 'Choose emoji' })).toHaveTextContent('👩🏽‍💻');
  });
});
