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
