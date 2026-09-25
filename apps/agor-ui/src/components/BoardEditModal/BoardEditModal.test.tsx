import type { AgorClient, Board, BoardCapabilityPolicies, User, UserID } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Form, Input } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardEditModal } from './BoardEditModal';

const showError = vi.hoisted(() => vi.fn());
vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showError, showSuccess: vi.fn() }),
}));
vi.mock('../JSONEditor', () => ({
  JSONEditor: () => <textarea aria-label="Custom Context (JSON)" />,
  validateJSON: () => Promise.resolve(),
}));
vi.mock('../permissions/CapabilityPolicyEditor', () => ({
  BoardCapabilityPolicyModalEditor: ({
    value,
    onChange,
    groups,
    ownershipAction,
  }: {
    ownershipAction?: React.ReactNode;
    value: BoardCapabilityPolicies;
    onChange: (value: BoardCapabilityPolicies) => void;
    groups: Array<{ name: string }>;
  }) => (
    <>
      {ownershipAction}
      <button
        type="button"
        data-sharing-mode={value.board_access.sharing_mode}
        onClick={() =>
          onChange({
            ...value,
            board_access: {
              ...value.board_access,
              sharing_mode: value.board_access.sharing_mode === 'shared' ? 'private' : 'shared',
            },
          })
        }
      >
        Change board access
      </button>
      <div
        data-testid="board-modal-policy-editor"
        data-group-names={groups.map((group) => group.name).join(',')}
      />
    </>
  ),
}));
vi.mock('../forms/BoardFormFields', () => ({
  BoardFormFields: ({
    capabilityPolicyEditor,
    zoneDefaultsEditor,
    canEditGeneral,
  }: {
    capabilityPolicyEditor?: React.ReactNode;
    zoneDefaultsEditor?: React.ReactNode;
    canEditGeneral?: boolean;
  }) => (
    <>
      <Form.Item name="name" label="Name" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <div data-testid="board-modal-can-edit-general" data-value={String(canEditGeneral)} />
      {capabilityPolicyEditor}
      {zoneDefaultsEditor && (
        <div data-testid="board-zone-defaults-editor">{zoneDefaultsEditor}</div>
      )}
    </>
  ),
  extractBoardFormValues: (
    form: { getFieldValue: (name: string) => unknown },
    options?: { includeLegacyPermissions?: boolean }
  ) => ({
    name: form.getFieldValue('name'),
    ...(options?.includeLegacyPermissions === false
      ? {}
      : {
          access_mode: 'shared',
          default_others_can: 'session',
          default_others_fs_access: 'read',
        }),
  }),
  isCustomCSS: () => false,
}));

const listedBoard = {
  board_id: 'board-1',
  name: 'Stale name',
  created_by: 'owner-1',
  created_at: '',
  last_updated: '',
} as Board;
const freshBoard = { ...listedBoard, name: 'Fresh name', icon: '✨' } as Board;
const policy: BoardCapabilityPolicies = {
  primary_owner_user_id: 'owner-1' as UserID,
  board_access_revision: 1,
  branch_template_revision: 1,
  board_access: {
    schema_version: 1,
    policy_kind: 'board_access',
    sharing_mode: 'shared',
    entries: [],
    others: { preset: 'viewer', capabilities: ['board.view'], fs_access: 'none' },
  },
  branch_template: {
    access: {
      schema_version: 1,
      policy_kind: 'branch_access',
      sharing_mode: 'shared',
      entries: [],
      others: { preset: 'collaborator', capabilities: ['branch.view'], fs_access: 'read' },
    },
    allow_shared_session_prompts: false,
  },
};

function makeClient(
  metadataError: { code?: number; message?: string } = { code: 404 },
  accessError?: Error
) {
  const get = vi.fn().mockResolvedValue(freshBoard);
  const boardPatch = vi.fn().mockResolvedValue({ changed: true, changed_zone_ids: [] });
  const permissionsFind = vi
    .fn()
    .mockImplementation(() =>
      metadataError.code && metadataError.code !== 404
        ? Promise.reject(metadataError)
        : Promise.resolve(policy)
    );
  const permissionsPatch = vi
    .fn()
    .mockImplementation(async (_id: unknown, value: unknown) => value);
  return {
    get,
    boardPatch,
    permissionsFind,
    permissionsPatch,
    client: {
      service: (name: string) => {
        if (name === 'boards') return { get, patch: boardPatch };
        if (name === 'boards/:id/permissions') {
          return {
            find: permissionsFind,
            patch: permissionsPatch,
          };
        }
        if (name === 'workspace-preferences') {
          return { find: vi.fn().mockResolvedValue({ session_sharing_enabled: false }) };
        }
        if (name === 'boards/:id/effective-access') {
          return {
            find: accessError
              ? vi.fn().mockRejectedValue(accessError)
              : vi.fn().mockResolvedValue({
                  capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
                  fs_access: 'none',
                  source: 'primary_owner',
                  group_ids: [],
                  is_primary_owner: true,
                }),
          };
        }
        return { findAll: vi.fn().mockResolvedValue([]) };
      },
    } as unknown as AgorClient,
  };
}

describe('BoardEditModal', () => {
  beforeEach(() => {
    showError.mockReset();
  });

  it('does not attach retired permission fields to a settings write when saving settings', async () => {
    const { client } = makeClient();
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={vi.fn()}
        onUpdate={onUpdate}
      />
    );

    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Fictional planning board' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(listedBoard.board_id, {
        name: 'Fictional planning board',
      })
    );
  });

  it('keeps a pending transfer and its completion result across same-board realtime updates', async () => {
    const { client: baseClient, get } = makeClient();
    const owner = { user_id: policy.primary_owner_user_id, role: 'admin', name: 'Owner' } as User;
    const successor = { user_id: 'successor' as UserID, role: 'member', name: 'Reed' } as User;
    let complete!: (value: unknown) => void;
    const patch = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const client = {
      service: (path: string) => {
        if (path === 'boards/:id/ownership') return { patch };
        if (path === 'users') return { findAll: vi.fn().mockResolvedValue([owner, successor]) };
        return baseClient.service(path);
      },
    } as unknown as AgorClient;
    const onClose = vi.fn();
    const editor = (board: Board) => (
      <BoardEditModal board={board} client={client} currentUser={owner} open onClose={onClose} />
    );
    const { rerender } = render(editor(listedBoard));
    const transferButton = await screen.findByLabelText('Transfer ownership');
    fireEvent.click(transferButton);
    // The settings modal now includes a full zone editor. Scope ownership
    // queries to its own dialog instead of repeatedly computing accessibility
    // for every unrelated AntD control in the underlying settings form.
    const transferDialog = within(
      screen.getByText('Transfer board ownership').closest<HTMLElement>('[role="dialog"]')!
    );
    fireEvent.mouseDown(transferDialog.getByRole('combobox', { name: 'Successor owner' }));
    fireEvent.click(await screen.findByText('Reed'));
    fireEvent.click(transferDialog.getByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch).toHaveBeenCalledWith(
      null,
      { expected_owner_user_id: owner.user_id, target_user_id: successor.user_id },
      { route: { id: listedBoard.board_id } }
    );

    // The canonical patched event can arrive before the command's reply.
    rerender(editor({ ...freshBoard, primary_owner_user_id: successor.user_id }));
    const pendingSuccessor = transferDialog.getByRole('combobox', { name: 'Successor owner' });
    expect(pendingSuccessor).toBeInTheDocument();
    expect(pendingSuccessor).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () =>
      complete({
        scope: 'management_only',
        previous_owner_access: { capabilities: ['board.view'], fs_access: 'none' },
      })
    );
    await transferDialog.findByRole('button', { name: 'Done' });
    rerender(
      editor({ ...freshBoard, primary_owner_user_id: successor.user_id, name: 'Realtime refresh' })
    );
    expect(transferDialog.getByText(/board.view/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(transferDialog.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('passes canEditGeneral=false through to BoardFormFields when the caller lacks board.edit', async () => {
    const get = vi.fn().mockResolvedValue(freshBoard);
    const client = {
      service: (name: string) => {
        if (name === 'boards') return { get };
        if (name === 'boards/:id/permissions') {
          return {
            find: vi.fn().mockResolvedValue(policy),
            patch: vi.fn().mockImplementation(async (_id: unknown, value: unknown) => value),
          };
        }
        if (name === 'workspace-preferences') {
          return { find: vi.fn().mockResolvedValue({ personal_session_sharing_enabled: false }) };
        }
        if (name === 'boards/:id/effective-access') {
          return {
            find: vi.fn().mockResolvedValue({
              capabilities: ['board.view'],
              fs_access: 'none',
              source: 'others',
              group_ids: [],
              is_primary_owner: false,
            }),
          };
        }
        return { findAll: vi.fn().mockResolvedValue([]) };
      },
    } as unknown as AgorClient;

    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={vi.fn()}
        onUpdate={vi.fn()}
      />
    );

    await screen.findByDisplayValue('Fresh name');
    expect(screen.getByTestId('board-modal-can-edit-general')).toHaveAttribute(
      'data-value',
      'false'
    );
    expect(screen.getByRole('spinbutton', { name: 'Horizontal gap' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Vertical gap' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Zone inner padding' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Apply to existing zones' })).toBeDisabled();
  });

  it('loads the latest board and normalized permission package before saving', async () => {
    const { client, get } = makeClient({ code: 404 });
    const onUpdate = vi.fn();
    const onClose = vi.fn();
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={onClose}
        onUpdate={onUpdate}
      />
    );

    expect(await screen.findByDisplayValue('Fresh name')).toBeInTheDocument();
    expect(screen.getByTestId('board-modal-policy-editor')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(listedBoard.board_id);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(listedBoard.board_id, { name: 'Renamed' })
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('saves zone defaults atomically and applies them only by explicit intent', async () => {
    const current = {
      ...freshBoard,
      zone_layout_defaults: { mode: 'manual', preset: 'grid', gap: 24 },
      objects: {
        review: {
          type: 'zone',
          x: 0,
          y: 0,
          width: 620,
          height: 400,
          label: 'Fictional review',
          layout: { mode: 'manual', preset: 'grid', gap: 40 },
        },
      },
    } as Board;
    const { client, get, boardPatch } = makeClient();
    get.mockResolvedValue(current);
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={vi.fn()}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const spacing = await screen.findByRole('spinbutton', { name: 'Horizontal gap' });
    fireEvent.change(spacing, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply to existing zones' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(boardPatch).toHaveBeenCalledOnce());
    expect(boardPatch).toHaveBeenCalledWith(
      listedBoard.board_id,
      expect.objectContaining({
        _action: 'setZoneLayoutDefaults',
        defaults: expect.objectContaining({ columnGap: 8, rowGap: 24, padding: 20 }),
        applyToExisting: true,
        expected: expect.objectContaining({
          zones: {
            review: expect.objectContaining({ binding: 'override' }),
          },
        }),
      })
    );
  });

  it('does not send a defaults action for an unchanged save', async () => {
    const { client, boardPatch } = makeClient();
    const onClose = vi.fn();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={onClose}
        onUpdate={onUpdate}
      />
    );

    await screen.findByDisplayValue('Fresh name');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onUpdate).not.toHaveBeenCalled();
    expect(boardPatch).not.toHaveBeenCalled();
  });

  it('still persists deliberately edited permissions through the policy service', async () => {
    const { client, permissionsPatch } = makeClient();
    const onClose = vi.fn();
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={onClose}
        onUpdate={vi.fn()}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Change board access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(permissionsPatch).toHaveBeenCalledWith(
      null,
      { ...policy, board_access: { ...policy.board_access, sharing_mode: 'private' } },
      { route: { id: listedBoard.board_id } }
    );
  });

  it('does not rewrite permissions when an edit is reverted before saving metadata', async () => {
    const { client, permissionsPatch } = makeClient();
    const onUpdate = vi.fn();
    const onClose = vi.fn();
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={onClose}
        onUpdate={onUpdate}
      />
    );
    const changeAccess = await screen.findByRole('button', { name: 'Change board access' });
    fireEvent.click(changeAccess);
    expect(changeAccess).toHaveAttribute('data-sharing-mode', 'private');
    fireEvent.click(changeAccess);
    expect(changeAccess).toHaveAttribute('data-sharing-mode', 'shared');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onUpdate).toHaveBeenCalledWith(listedBoard.board_id, { name: 'Renamed' });
    expect(permissionsPatch).not.toHaveBeenCalled();
  });

  it('keeps normalized group principals selectable', async () => {
    const get = vi.fn().mockResolvedValue(freshBoard);
    const client = {
      service: (name: string) => {
        if (name === 'boards') return { get };
        if (name === 'users') return { findAll: vi.fn().mockResolvedValue([]) };
        if (name === 'groups') {
          return {
            findAll: vi
              .fn()
              .mockResolvedValue([{ group_id: 'group-design', name: 'Product Design' }]),
          };
        }
        if (name === 'boards/:id/permissions') {
          return {
            find: vi.fn().mockResolvedValue(policy),
            patch: vi.fn().mockImplementation(async (_id: unknown, value: unknown) => value),
          };
        }
        if (name === 'workspace-preferences') {
          return { find: vi.fn().mockResolvedValue({ session_sharing_enabled: false }) };
        }
        if (name === 'boards/:id/effective-access') {
          return {
            find: vi.fn().mockResolvedValue({
              capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
              fs_access: 'none',
              source: 'primary_owner',
              group_ids: [],
              is_primary_owner: true,
            }),
          };
        }
        throw new Error(`Unexpected service: ${name}`);
      },
    } as unknown as AgorClient;

    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={vi.fn()}
        onUpdate={vi.fn()}
      />
    );

    expect(await screen.findByTestId('board-modal-policy-editor')).toHaveAttribute(
      'data-group-names',
      'Product Design'
    );
  });

  it('surfaces non-404 metadata failures and prevents saving stale settings', async () => {
    const { client } = makeClient({ code: 500, message: 'metadata unavailable' });
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={vi.fn()}
        onUpdate={vi.fn()}
      />
    );

    expect(await screen.findByText('Board settings unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByDisplayValue('Stale name')).not.toBeInTheDocument();
  });

  it('surfaces a failed effective-access request instead of misreporting an owner policy denial', async () => {
    const { client } = makeClient(undefined, new Error('Authentication required'));
    const onUpdate = vi.fn();
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={vi.fn()}
        onUpdate={onUpdate}
      />
    );
    expect(await screen.findByText('Board settings unavailable')).toBeInTheDocument();
    expect(
      screen.getByText(/Could not load current board settings: Authentication required/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByTestId('board-modal-can-edit-general')).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('awaits the board mutation before closing', async () => {
    const { client } = makeClient({ code: 404 });
    let resolveUpdate: (() => void) | undefined;
    const onUpdate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        })
    );
    const onClose = vi.fn();
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={onClose}
        onUpdate={onUpdate}
      />
    );
    await screen.findByDisplayValue('Fresh name');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Awaited name' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();

    resolveUpdate?.();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('stays open when the board mutation reports failure', async () => {
    const { client } = makeClient({ code: 404 });
    const onClose = vi.fn();
    const onUpdate = vi.fn().mockResolvedValue(false);
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={onClose}
        onUpdate={onUpdate}
      />
    );
    await screen.findByDisplayValue('Fresh name');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rejected name' } });
    const save = await screen.findByRole('button', { name: 'Save' });
    fireEvent.click(save);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    // The loading icon temporarily changes the accessible name to "loading
    // Save". Await the mutation and actual busy-state exit, not that label.
    await waitFor(() => expect(save).not.toHaveClass('ant-btn-loading'));
    expect(save).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
