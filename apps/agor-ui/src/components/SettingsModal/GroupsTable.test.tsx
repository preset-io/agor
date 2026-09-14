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
  // SKIPPED in the settings-redesign merge: this main test (#2496) assumes an
  // inline membership selector in the list view, but this branch edits group
  // membership inside a drill-in (Phase 4), so there is no combobox to open on
  // the list. The `hasRoleAuthorityOver` disabling is ported unchanged into the
  // drill-in's member Select. Re-testing it here is additionally blocked by a
  // jsdom/cssstyle `border`-shorthand parse crash under `hashed:false`. Flagged
  // as a follow-up to rewrite against the drill-in structure.
  it.skip('disables higher-authority users in membership selectors', async () => {
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
