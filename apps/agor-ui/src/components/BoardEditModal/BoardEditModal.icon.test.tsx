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
  const policy = {
    primary_owner_user_id: 'owner-1',
    board_access_revision: 1,
    branch_template_revision: 1,
    board_access: {
      schema_version: 1,
      policy_kind: 'board_access',
      sharing_mode: 'private',
      entries: [],
      others: { preset: 'none', capabilities: [], fs_access: 'none' },
    },
    branch_template: {
      access: {
        schema_version: 1,
        policy_kind: 'branch_access',
        sharing_mode: 'private',
        entries: [],
        others: { preset: 'none', capabilities: [], fs_access: 'none' },
      },
      allow_shared_session_prompts: false,
    },
  };
  return {
    service: (name: string) => {
      if (name === 'boards') return { get: vi.fn().mockImplementation(getBoard) };
      if (name === 'boards/:id/permissions') {
        return {
          find: vi.fn().mockResolvedValue(policy),
          patch: vi.fn(async (_id: unknown, value: unknown) => value),
        };
      }
      if (name === 'workspace-preferences') {
        return { find: vi.fn().mockResolvedValue({ session_sharing_enabled: false }) };
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
