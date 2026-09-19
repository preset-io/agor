import type { AgorClient, User, UserID } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { OwnershipTransfer } from './OwnershipTransfer';

vi.mock('@/utils/message', () => ({ useThemedMessage: () => ({ showSuccess: vi.fn() }) }));
const owner = {
  user_id: 'owner' as UserID,
  name: 'Elizabeth',
  email: 'owner@example.test',
  role: 'member',
} as User;
const successor = { ...owner, user_id: 'successor' as UserID, name: 'Reed' };
const viewer = { ...owner, user_id: 'viewer' as UserID, name: 'Viewer', role: 'viewer' } as User;

function setup(currentUser = owner, fail = false) {
  const patch = fail
    ? vi.fn().mockRejectedValue(new Error('Primary owner changed; reload before transferring'))
    : vi.fn().mockResolvedValue({
        scope: 'management_only',
        previous_owner_access: { capabilities: ['board.view'] },
      });
  const service = vi.fn().mockReturnValue({ patch });
  const onTransferred = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <OwnershipTransfer
        kind="board"
        resourceId="board-id"
        ownerUserId={owner.user_id}
        currentUser={currentUser}
        users={[owner, successor, viewer]}
        client={{ service } as unknown as AgorClient}
        onTransferred={onTransferred}
      />
    </ConfigProvider>
  );
  return { patch, service, onTransferred };
}

describe('ownership transfer command', () => {
  it('does not expose transfer to another ordinary member', () => {
    setup(successor);
    expect(screen.queryByRole('button', { name: 'Transfer ownership' })).toBeNull();
  });
  it('offers transfer to a tenant admin who is not the owner', () => {
    setup({ ...successor, role: 'admin' });
    const button = screen.getByRole('button', { name: 'Transfer ownership' });
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('');
    expect(button.querySelector('svg')).toBeInTheDocument();
  });
  it('requires a successor and confirmation, excludes viewers, and reports remaining access', async () => {
    const { patch, service, onTransferred } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }));
    expect(screen.getByText(/Existing work is not paused or reassigned/)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Successor owner' }));
    expect(screen.queryByText('Viewer')).toBeNull();
    fireEvent.click(await screen.findByText('Reed'));
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Transfer ownership' }).at(-1)!);
    await screen.findByRole('button', { name: 'Done' });
    expect(service).toHaveBeenCalledWith('boards/:id/ownership');
    expect(patch).toHaveBeenCalledWith(
      null,
      { expected_owner_user_id: 'owner', target_user_id: 'successor' },
      { route: { id: 'board-id' } }
    );
    expect(screen.getByText(/board.view/)).toBeInTheDocument();
    expect(onTransferred).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onTransferred).toHaveBeenCalledOnce();
  });
  it('keeps a failed/conflicting transfer open without reporting success', async () => {
    const { onTransferred } = setup(owner, true);
    fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Successor owner' }));
    fireEvent.click(await screen.findByText('Reed'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Transfer ownership' }).at(-1)!);
    await waitFor(() => expect(screen.getByText(/Primary owner changed/)).toBeInTheDocument());
    expect(onTransferred).not.toHaveBeenCalled();
  });
});
