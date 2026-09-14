import type { AgorClient, Board, EffectiveCapabilityPolicyAccess, User } from '@agor-live/client';
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
  primary_owner_user_id: 'owner-1',
  created_at: '',
  last_updated: '',
} as Board;
const owner = { user_id: 'owner-1', role: 'member' } as User;
const collaborator = { user_id: 'collaborator-1', role: 'member' } as User;

function makeClient(
  getBoard: () => Board,
  capabilities: EffectiveCapabilityPolicyAccess['capabilities'] = ['board.view', 'board.edit'],
  permissionsPatch = vi.fn(async (_id: unknown, value: unknown) => value)
): AgorClient {
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
          patch: permissionsPatch,
        };
      }
      if (name === 'workspace-preferences') {
        return { find: vi.fn().mockResolvedValue({ session_sharing_enabled: false }) };
      }
      if (name === 'boards/:id/effective-access') {
        return {
          find: vi.fn().mockResolvedValue({
            capabilities,
          }),
        };
      }
      return { findAll: vi.fn().mockResolvedValue([]) };
    },
  } as unknown as AgorClient;
}

describe('BoardEditModal — board metadata', () => {
  it('edits name, emoji and description on an owner-only board, without rewriting permissions', async () => {
    let savedBoard = { ...listedBoard, icon: '🚩' } as Board;
    const onUpdate = vi.fn(async (_id: string, updates: Partial<Board>) => {
      savedBoard = { ...savedBoard, ...updates };
    });
    const permissionsPatch = vi.fn();
    const client = makeClient(() => savedBoard, undefined, permissionsPatch);
    const view = render(
      <AntApp>
        <BoardEditModal
          board={listedBoard}
          client={client}
          open
          onClose={vi.fn()}
          onUpdate={onUpdate}
          currentUser={owner}
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
    fireEvent.change(screen.getByPlaceholderText('My Board'), {
      target: { value: 'Renamed board' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'New description' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0]?.[1]).toMatchObject({
      name: 'Renamed board',
      icon: '👩🏽‍💻',
      description: 'New description',
    });
    expect(permissionsPatch).not.toHaveBeenCalled();

    view.rerender(
      <AntApp>
        <BoardEditModal
          board={listedBoard}
          client={client}
          open={false}
          onClose={vi.fn()}
          onUpdate={onUpdate}
          currentUser={owner}
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
          currentUser={owner}
        />
      </AntApp>
    );
    expect(await screen.findByRole('button', { name: 'Choose emoji' })).toHaveTextContent('👩🏽‍💻');
    expect(screen.getByPlaceholderText('My Board')).toHaveValue('Renamed board');
    expect(screen.getByLabelText('Description')).toHaveValue('New description');
  });

  it('disables all metadata fields and Save for a non-owner without board.edit', async () => {
    const onUpdate = vi.fn();
    render(
      <AntApp>
        <BoardEditModal
          board={listedBoard}
          client={makeClient(() => listedBoard, ['board.view'])}
          currentUser={collaborator}
          open
          onClose={vi.fn()}
          onUpdate={onUpdate}
        />
      </AntApp>
    );
    expect(await screen.findByRole('button', { name: 'Choose emoji' })).toBeDisabled();
    expect(screen.getByPlaceholderText('My Board')).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('lets an Editor save metadata without attempting a Manager-only policy write', async () => {
    const permissionsPatch = vi.fn().mockRejectedValue(new Error('Cannot manage policy'));
    const onUpdate = vi.fn();
    const onClose = vi.fn();
    render(
      <AntApp>
        <BoardEditModal
          board={listedBoard}
          client={makeClient(() => listedBoard, ['board.view', 'board.edit'], permissionsPatch)}
          currentUser={collaborator}
          open
          onClose={onClose}
          onUpdate={onUpdate}
        />
      </AntApp>
    );
    expect(await screen.findByRole('button', { name: 'Choose emoji' })).toBeEnabled();
    fireEvent.change(screen.getByPlaceholderText('My Board'), {
      target: { value: 'Editor rename' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onUpdate).toHaveBeenCalledWith(
      listedBoard.board_id,
      expect.objectContaining({ name: 'Editor rename' })
    );
    expect(permissionsPatch).not.toHaveBeenCalled();
  });
});
