import type { AgorClient, Group, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { GroupsTable } from './GroupsTable';

function user(user_id: string, role: User['role']): User {
  return {
    user_id,
    email: `${user_id}@example.test`,
    name: user_id,
    role,
    created_at: new Date(),
  } as User;
}

describe('GroupsTable membership authority', () => {
  it('disables higher-authority users in membership selectors', async () => {
    const group = {
      group_id: 'group-1',
      name: 'Engineering',
      slug: 'engineering',
    } as Group;
    const client = {
      service: vi.fn((path: string) => ({
        findAll: vi.fn(async () => (path === 'groups' ? [group] : [])),
      })),
    } as unknown as AgorClient;
    const admin = user('admin', 'admin');
    const superadmin = user('superadmin', 'superadmin');
    const member = user('member', 'member');

    render(
      <ConfigProvider theme={{ hashed: false }}>
        <AntApp>
          <GroupsTable
            client={client}
            currentUser={admin}
            userById={
              new Map([
                [admin.user_id, admin],
                [superadmin.user_id, superadmin],
                [member.user_id, member],
              ])
            }
          />
        </AntApp>
      </ConfigProvider>
    );

    expect(await screen.findByText('Engineering')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox'));
    const superadminOption = await screen.findByText('superadmin (superadmin@example.test)');
    const memberOption = await screen.findByText('member (member@example.test)');
    expect(superadminOption.closest('[aria-disabled]')).toHaveAttribute('aria-disabled', 'true');
    expect(memberOption.closest('[aria-disabled]')).toHaveAttribute('aria-disabled', 'false');
  });
});

describe('GroupsTable failures', () => {
  const admin = user('admin', 'admin');
  function renderGroups(service: (path: string) => Record<string, unknown>) {
    const client = { service: vi.fn(service) } as unknown as AgorClient;
    return render(
      <ConfigProvider theme={{ hashed: false }}>
        <AntApp>
          <GroupsTable
            client={client}
            currentUser={admin}
            userById={new Map([[admin.user_id, admin]])}
          />
        </AntApp>
      </ConfigProvider>
    );
  }

  it('shows a load failure and retries on Try again', async () => {
    const findAll = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([{ group_id: 'g1', name: 'Engineering', slug: 'eng' }]);
    renderGroups((path) => ({
      findAll: path === 'groups' ? findAll : vi.fn().mockResolvedValue([]),
    }));
    expect(await screen.findByText("Couldn't load groups.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
  });

  it('keeps the create form open with its values and the error', async () => {
    const create = vi.fn().mockRejectedValue(new Error('boom'));
    renderGroups(() => ({ findAll: vi.fn().mockResolvedValue([]), create }));
    fireEvent.click(await screen.findByRole('button', { name: /new group/i }));
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Design' } });
    fireEvent.click(screen.getByRole('button', { name: /^ok$/i }));
    expect(await screen.findByText("Couldn't create the group.")).toBeInTheDocument();
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Name')).toHaveValue('Design');
  });
});
