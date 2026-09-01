// biome-ignore-all lint/plugin/noHardcodedColorLiteral: test fixture asserts on a literal CSS gradient value
import type { AgorClient, Board } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardEditModal } from './BoardEditModal';

// Mock only peripheral deps; the REAL BoardFormFields + BoardBackgroundEditor
// render so this exercises the full modal → editor lifecycle.
const showError = vi.hoisted(() => vi.fn());
vi.mock('@/utils/message', () => ({ useThemedMessage: () => ({ showError }) }));
vi.mock('../JSONEditor', () => ({
  JSONEditor: () => <textarea aria-label="Custom Context (JSON)" />,
  validateJSON: () => Promise.resolve(),
}));

const CUSTOM_GRADIENT = 'linear-gradient(180deg, #101010, #202020)';

const listedBoard = {
  board_id: 'board-1',
  name: 'Styled board',
  created_by: 'owner-1',
  created_at: '',
  last_updated: '',
} as Board;

function makeClient(board: Board) {
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
      if (name === 'boards') return { get: vi.fn().mockResolvedValue(board) };
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

async function openCssTabAndReadBackground(): Promise<string> {
  // Wait for the loaded form, then open the CSS tab and read the editor value.
  await screen.findByDisplayValue('Styled board');
  fireEvent.click(screen.getByRole('tab', { name: 'CSS' }));
  const textarea = (await screen.findByLabelText('Custom background CSS')) as HTMLTextAreaElement;
  return textarea.value;
}

describe('BoardEditModal — background editor persistence across reopen', () => {
  beforeEach(() => showError.mockReset());

  it('shows the saved custom background, and still shows it after close + reopen', async () => {
    const board = { ...listedBoard, background_color: CUSTOM_GRADIENT } as Board;
    const client = makeClient(board);
    const onClose = vi.fn();

    const view = render(
      <AntApp>
        <BoardEditModal board={listedBoard} client={client} open onClose={onClose} />
      </AntApp>
    );

    expect(await openCssTabAndReadBackground()).toBe(CUSTOM_GRADIENT);

    // Close (destroyOnHidden unmounts the modal content) …
    view.rerender(
      <AntApp>
        <BoardEditModal board={listedBoard} client={client} open={false} onClose={onClose} />
      </AntApp>
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Custom background CSS')).not.toBeInTheDocument()
    );

    // … and reopen: the saved value must round-trip back into Custom mode.
    view.rerender(
      <AntApp>
        <BoardEditModal board={listedBoard} client={client} open onClose={onClose} />
      </AntApp>
    );
    expect(await openCssTabAndReadBackground()).toBe(CUSTOM_GRADIENT);
  });
});
