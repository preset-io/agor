/**
 * Which settings sections each role is offered.
 *
 * The rule the nav has to encode is the daemon's, not a taste: an entry may
 * appear only where the service behind it will answer. `users.find` takes
 * MEMBER, so members keep the roster; `groups` is ADMIN-only; a viewer ranks
 * below MEMBER and gets neither, which must also take the now-empty "Admin"
 * heading with it.
 */

import type { User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { Grid } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type SettingsSection, useSettingsRoute } from '../../hooks/useSettingsRoute';
import { SettingsModal } from './SettingsModal';

vi.mock('./BoardsTable', () => ({
  BoardsTable: () => <input aria-label="settings-private-draft" defaultValue="" />,
}));

beforeEach(() => {
  vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
});

function makeUser(role: string): User {
  return { user_id: `user-${role}`, email: `${role}@agor.live`, name: role, role } as User;
}

function renderNav(role: string, activeTab = 'boards') {
  return render(
    <SettingsModal
      open
      onClose={vi.fn()}
      client={null}
      currentUser={makeUser(role)}
      activeTab={activeTab}
    />
  );
}

function RoutedSettings({ role }: { role: string }) {
  const settingsRoute = useSettingsRoute();
  return (
    <SettingsModal
      open={settingsRoute.isOpen}
      onClose={settingsRoute.closeSettings}
      client={null}
      currentUser={makeUser(role)}
      activeTab={settingsRoute.section}
      onTabChange={(section) => settingsRoute.setSection(section as SettingsSection)}
    />
  );
}

/** Drive the same URL parser and section prop seam App uses in production. */
function renderDeepLink(role: string, section: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings/${section}/`]}>
      <RoutedSettings role={role} />
    </MemoryRouter>
  );
}

/** Menu entry labels, which is what "is this offered?" means here. */
function menuLabels(): string[] {
  return screen.getAllByRole('menuitem').map((item) => item.textContent?.trim() ?? '');
}

describe('SettingsModal navigation gating', () => {
  it('destroys the settings state tree on a same-role identity replacement', () => {
    const adminA = { ...makeUser('admin'), user_id: 'admin-a' } as User;
    const adminB = { ...makeUser('admin'), user_id: 'admin-b' } as User;
    const view = (currentUser: User) => (
      <SettingsModal
        open
        onClose={vi.fn()}
        client={null}
        currentUser={currentUser}
        activeTab="boards"
      />
    );
    const rendered = render(view(adminA));
    fireEvent.change(screen.getByLabelText('settings-private-draft'), {
      target: { value: 'admin-a-private-value' },
    });

    rendered.rerender(view(adminB));

    expect(screen.getByLabelText('settings-private-draft')).toHaveValue('');
  });

  it('offers an admin both Groups and Users', () => {
    renderNav('admin');

    expect(menuLabels()).toContain('Groups');
    expect(menuLabels()).toContain('Users');
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('offers a member Users but not Groups', () => {
    renderNav('member');

    // Kept on purpose: the daemon serves members the roster, so hiding it would
    // withhold something they are allowed to read.
    expect(menuLabels()).toContain('Users');
    expect(menuLabels()).not.toContain('Groups');
  });

  it('offers a viewer neither, and drops the empty Admin heading with them', () => {
    renderNav('viewer');

    expect(menuLabels()).not.toContain('Users');
    expect(menuLabels()).not.toContain('Groups');
    // An "Admin" group label with nothing under it is the bug this guards.
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('keeps the admin-only integrations gated the way they already were', () => {
    renderNav('member');

    expect(menuLabels()).not.toContain('Agentic Tools');
    expect(menuLabels()).not.toContain('Gateway Channels');
    // MCP Servers stays: members may read the policy that constrains them.
    expect(menuLabels()).toContain('MCP Servers');
  });
});

/**
 * Every gated section is routable through useSettingsRoute, so gating only the
 * menu leaves the pane reachable by URL with nothing selected in the sidebar.
 * The menu and the content read one predicate; these hold them together.
 */
describe('SettingsModal deep-linked sections', () => {
  /**
   * The settings content region. Asserting it is *empty* is what makes these
   * mutation-sensitive: several panes already refuse a non-admin with their own
   * message (GroupsTable renders "Only admins can manage groups."), so checking
   * for an absent table would pass whether or not the section is guarded.
   */
  const contentPane = () => document.querySelector('.ant-layout-content')?.firstElementChild;

  it('renders nothing for a viewer deep-linked to users', () => {
    renderDeepLink('viewer', 'users');

    expect(contentPane()).toBeNull();
  });

  it('renders nothing for a member deep-linked to an admin-only section', () => {
    // `groups`, `gateway` and `agentic-tools` already had this shape before the
    // users entry was gated; one predicate now covers all four.
    for (const section of ['groups', 'gateway', 'agentic-tools']) {
      const { unmount } = renderDeepLink('member', section);
      expect(contentPane(), `${section} should not render for a member`).toBeNull();
      unmount();
    }
  });

  it('still renders the sections each role may open', () => {
    // The positive control: without it, a guard that hid everything would pass.
    const { unmount } = renderDeepLink('member', 'users');
    expect(contentPane()).not.toBeNull();
    unmount();

    renderDeepLink('admin', 'groups');
    expect(contentPane()).not.toBeNull();
  });
});
