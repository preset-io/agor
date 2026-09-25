import type { User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '@/contexts/ConnectionContext';
import { ForcePasswordChangeModal } from './ForcePasswordChangeModal';

const user = (id: string): User =>
  ({
    user_id: id,
    email: `${id}@example.test`,
    role: 'admin',
    must_change_password: true,
  }) as User;

describe('ForcePasswordChangeModal authority fencing', () => {
  it('does not call the lazy modal form while closed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            authGeneration: 1,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <ForcePasswordChangeModal
            open={false}
            user={user('admin-a')}
            onChangePassword={vi.fn()}
            onLogout={vi.fn()}
          />
        </ConnectionProvider>
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(
        consoleError.mock.calls.some(([message]) =>
          String(message).includes('Instance created by `useForm` is not connected')
        )
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('erases A password fields and drops validation continuation before admin B can use it', async () => {
    const onChangePassword = vi.fn().mockResolvedValue(undefined);
    const view = (current: User, authGeneration: number) => (
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <ForcePasswordChangeModal
          open
          user={current}
          onChangePassword={onChangePassword}
          onLogout={vi.fn()}
        />
      </ConnectionProvider>
    );
    const rendered = render(view(user('admin-a'), 4));
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'admin-a-secret-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'admin-a-secret-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

    // Replace authority in the same commit window in which Ant validation's
    // promise resolves. The render-invalidated operation must win.
    rendered.rerender(view(user('admin-b'), 5));
    await Promise.resolve();
    expect(onChangePassword).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('New Password')).toHaveValue(''));
    expect(screen.getByLabelText('Confirm Password')).toHaveValue('');
  });

  it('keeps a same-user draft on reconnect but cancels its obsolete submit', async () => {
    const onChangePassword = vi.fn().mockResolvedValue(undefined);
    const makeView = (connected: boolean, generation: number) => (
      <ConnectionProvider
        value={{
          connected,
          connecting: !connected,
          authGeneration: generation,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <ForcePasswordChangeModal
          open
          user={user('admin-a')}
          onChangePassword={onChangePassword}
          onLogout={vi.fn()}
        />
      </ConnectionProvider>
    );
    const rendered = render(makeView(true, 8));
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'same-user-draft-password' },
    });
    rendered.rerender(makeView(false, 8));
    expect(screen.getByLabelText('New Password')).toHaveValue('same-user-draft-password');
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    await Promise.resolve();
    expect(onChangePassword).not.toHaveBeenCalled();
  });
});
