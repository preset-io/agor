import type { AgorClient, Board, BoardCapabilityPolicies } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form, Input } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { BoardEditModal } from './BoardEditModal';

const showError = vi.hoisted(() => vi.fn());
vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showError }),
}));
vi.mock('../JSONEditor', () => ({
  JSONEditor: () => <textarea aria-label="Custom Context (JSON)" />,
  validateJSON: () => Promise.resolve(),
}));
vi.mock('../forms/BoardFormFields', () => ({
  BoardFormFields: ({
    capabilityPolicyEditor,
    zoneDefaultsEditor,
    allGroups,
    rbacEnabled,
    canEditGeneral,
  }: {
    capabilityPolicyEditor?: React.ReactNode;
    zoneDefaultsEditor?: React.ReactNode;
    allGroups?: Array<{ name: string }>;
    rbacEnabled?: boolean;
    canEditGeneral?: boolean;
  }) => (
    <>
      <Form.Item name="name" label="Name" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <div data-testid="board-modal-can-edit-general" data-value={String(canEditGeneral)} />
      {capabilityPolicyEditor && (
        <div
          data-testid="board-modal-policy-editor"
          data-group-names={allGroups?.map((group) => group.name).join(',')}
          data-rbac-enabled={String(rbacEnabled)}
        />
      )}
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
const policy = {
  primary_owner_user_id: 'owner-1',
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
} as BoardCapabilityPolicies;

function makeClient(metadataError: { code?: number; message?: string } = { code: 404 }) {
  const get = vi.fn().mockResolvedValue(freshBoard);
  const boardPatch = vi.fn().mockResolvedValue({ changed: true, changed_zone_ids: [] });
  const permissionsFind = vi
    .fn()
    .mockImplementation(() =>
      metadataError.code && metadataError.code !== 404
        ? Promise.reject(metadataError)
        : Promise.resolve(policy)
    );
  return {
    get,
    boardPatch,
    permissionsFind,
    client: {
      service: (name: string) => {
        if (name === 'boards') return { get, patch: boardPatch };
        if (name === 'boards/:id/permissions') {
          return {
            find: permissionsFind,
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
        return { findAll: vi.fn().mockResolvedValue([]) };
      },
    } as unknown as AgorClient,
  };
}

describe('BoardEditModal', () => {
  beforeEach(() => {
    showError.mockReset();
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: true });
  });

  it('keeps the normalized editor and policy request hidden when RBAC is disabled', async () => {
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: false });
    const { client, permissionsFind } = makeClient();

    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={vi.fn()}
        onUpdate={vi.fn()}
      />
    );

    expect(await screen.findByDisplayValue('Fresh name')).toBeInTheDocument();
    expect(screen.queryByTestId('board-modal-policy-editor')).not.toBeInTheDocument();
    expect(permissionsFind).not.toHaveBeenCalled();
  });

  it('defaults canEditGeneral to true when RBAC is disabled, without fetching effective-access', async () => {
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: false });
    const { client } = makeClient();

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
      'true'
    );
  });

  it('does not attach retired permission fields to a settings write when RBAC is disabled', async () => {
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: false });
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
    expect(screen.getByRole('spinbutton', { name: 'Spacing' })).toBeDisabled();
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

    const spacing = await screen.findByRole('spinbutton', { name: 'Spacing' });
    fireEvent.change(spacing, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply to existing zones' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(boardPatch).toHaveBeenCalledOnce());
    expect(boardPatch).toHaveBeenCalledWith(
      listedBoard.board_id,
      expect.objectContaining({
        _action: 'setZoneLayoutDefaults',
        defaults: expect.objectContaining({ gap: 8 }),
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
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
  });
});
