import type { User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { describe, expect, it, vi } from 'vitest';
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

function renderTable(currentUser: User, users: User[]) {
  return render(
    <ConfigProvider theme={{ hashed: false }}>
      <AntApp>
        <UsersTable
          userById={new Map(users.map((item) => [item.user_id, item]))}
          client={null}
          currentUser={currentUser}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
        />
      </AntApp>
    </ConfigProvider>
  );
}

describe('UsersTable role authority', () => {
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
});
