import type { AgorClient, Board } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form, Input } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    capabilityPolicyPrototype,
  }: {
    capabilityPolicyPrototype?: React.ReactNode;
  }) => (
    <>
      <Form.Item name="name" label="Name" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      {capabilityPolicyPrototype && <div data-testid="board-modal-policy-prototype" />}
    </>
  ),
  extractBoardFormValues: (form: { getFieldValue: (name: string) => unknown }) => ({
    name: form.getFieldValue('name'),
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

function makeClient(metadataError: { code?: number; message?: string } = { code: 404 }) {
  const get = vi.fn().mockResolvedValue(freshBoard);
  return {
    get,
    client: {
      service: (name: string) => {
        if (name === 'boards') return { get };
        if (name === 'boards/:id/owners' || name === 'boards/:id/group-grants') {
          return { find: vi.fn().mockRejectedValue(metadataError) };
        }
        return { findAll: vi.fn().mockResolvedValue([]) };
      },
    } as unknown as AgorClient,
  };
}

describe('BoardEditModal', () => {
  beforeEach(() => showError.mockReset());

  it('loads the latest full board and permits save when RBAC routes are disabled', async () => {
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
    expect(screen.getByTestId('board-modal-policy-prototype')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(listedBoard.board_id);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(listedBoard.board_id, { name: 'Renamed' })
    );
    expect(onClose).toHaveBeenCalledOnce();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();

    resolveUpdate?.();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('stays open when the board mutation reports failure', async () => {
    const { client } = makeClient({ code: 404 });
    const onClose = vi.fn();
    render(
      <BoardEditModal
        board={listedBoard}
        client={client}
        open
        onClose={onClose}
        onUpdate={vi.fn().mockResolvedValue(false)}
      />
    );
    await screen.findByDisplayValue('Fresh name');
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
