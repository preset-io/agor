import type { User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { UsersTable } from './UsersTable';

function user(user_id: string, role: User['role']): User {
  return {
    user_id,
    email: `${user_id}@example.test`,
    name: user_id,
    role,
    created_at: new Date(),
    default_agentic_config: {},
  } as User;
}

function renderTable(
  currentUser: User,
  users: User[],
  onCreate: NonNullable<ComponentProps<typeof UsersTable>['onCreate']> = vi.fn()
) {
  return render(
    <ConfigProvider theme={{ hashed: false }}>
      <AntApp>
        <UsersTable
          userById={new Map(users.map((item) => [item.user_id, item]))}
          client={null}
          currentUser={currentUser}
          onCreate={onCreate}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
        />
      </AntApp>
    </ConfigProvider>
  );
}

describe('UsersTable role authority', () => {
  beforeEach(() => {
    // Legacy/local authority is permissive; individual tests override this
    // retained health snapshot when exercising delegated capabilities.
    __setAuthConfigForTests({ requireAuth: true });
  });

  it('hides superadmin mutation actions from admins but keeps member actions', () => {
    const admin = user('admin', 'admin');
    const superadmin = user('superadmin', 'superadmin');
    const member = user('member', 'member');
    renderTable(admin, [admin, superadmin, member]);

    expect(screen.queryByLabelText('Edit superadmin@example.test')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delete superadmin@example.test')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Edit member@example.test')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete member@example.test')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit admin@example.test')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete admin@example.test')).not.toBeInTheDocument();
  });

  it('does not offer superadmin in an admin create-role selector', async () => {
    const admin = user('admin', 'admin');
    renderTable(admin, [admin]);

    fireEvent.click(screen.getByRole('button', { name: /new user/i }));
    const roleSelect = screen.getAllByRole('combobox').at(-1);
    expect(roleSelect).toBeDefined();
    fireEvent.mouseDown(roleSelect!);

    expect(await screen.findByText('Admin')).toBeInTheDocument();
    expect(screen.queryByText('Superadmin')).not.toBeInTheDocument();
  });

  it('keeps rejected create values open and attaches stable password errors to the field', async () => {
    const admin = user('admin', 'admin');
    const rejection = Object.assign(new Error('Choose a less common password or passphrase.'), {
      data: { code: 'PASSWORD_COMMON' },
    });
    const onCreate = vi.fn().mockRejectedValue(rejection);
    renderTable(admin, [admin], onCreate);

    fireEvent.click(screen.getByRole('button', { name: /new user/i }));
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), {
      target: { value: 'new-user@example.test' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'password1234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog', { name: 'Create User' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('user@example.com')).toHaveValue('new-user@example.test');
    expect(screen.getByPlaceholderText('••••••••')).toHaveValue('password1234567');
    expect(
      await screen.findByText('Choose a less common password or passphrase.')
    ).toBeInTheDocument();
  });

  it('composes external lifecycle capabilities with role authority', () => {
    __setAuthConfigForTests({
      requireAuth: true,
      identity: {
        contractVersion: 1,
        userLifecycle: 'external',
        roleAuthority: 'claims',
        localAuth: 'disabled',
        external: { provider: 'external_launch', provisioning: 'jit' },
        capabilities: {
          users: {
            create: false,
            delete: false,
            identityWrite: false,
            roleWrite: false,
            passwordWrite: false,
            avatarSettingsWrite: false,
            selfConfigurationWrite: true,
          },
        },
      },
    });
    const admin = user('admin', 'admin');
    const member = user('member', 'member');
    renderTable(admin, [admin, member]);

    expect(screen.queryByRole('button', { name: /new user/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Edit admin@example.test')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit member@example.test')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete member@example.test')).not.toBeInTheDocument();
  });
});
