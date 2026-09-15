import type { AgorClient } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ConnectionProvider } from '@/contexts/ConnectionContext';
import { makeRepo, makeUser } from '../BranchModal/testUtils';
import { RepoCleanupSettingsModal } from './RepoCleanupSettingsModal';

it('releases a stale save on reconnect without losing the draft or applying its response', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const patch = vi
    .fn()
    .mockImplementationOnce(() => pending)
    .mockResolvedValue({});
  const client = { service: () => ({ patch }) } as unknown as AgorClient;
  const repo = makeRepo();
  const user = makeUser({ role: 'admin' });
  const onSaved = vi.fn();
  const view = (generation: number, connected = true) => (
    <ConnectionProvider
      value={{
        connected,
        connecting: false,
        authGeneration: generation,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <RepoCleanupSettingsModal
        client={client}
        user={user}
        repo={repo}
        open
        onSaved={onSaved}
        onCancel={vi.fn()}
      />
    </ConnectionProvider>
  );
  const rendered = render(view(1));
  fireEvent.click(screen.getByRole('button', { name: /Branch cleanup/ }));
  fireEvent.change(screen.getByLabelText('Cleanup command'), { target: { value: './draft.sh' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  });
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: /Save settings/ })).toHaveClass('ant-btn-loading');

  rendered.rerender(view(1, false));
  expect(screen.getByRole('button', { name: /Save settings/ })).toBeDisabled();
  rendered.rerender(view(2));
  expect(screen.getByLabelText('Cleanup command')).toHaveValue('./draft.sh');
  expect(screen.getByLabelText('Cleanup command')).toBeEnabled();
  expect(screen.getByRole('button', { name: /Save settings/ })).not.toHaveClass('ant-btn-loading');
  await act(async () => {
    resolve();
    await pending;
  });
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Cleanup command')).toHaveValue('./draft.sh');
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(patch.mock.calls[1][1].cleanup_policy.command).toBe('./draft.sh');
});
