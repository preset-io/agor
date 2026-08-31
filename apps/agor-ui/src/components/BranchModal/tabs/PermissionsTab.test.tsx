import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeBranchPolicy, makeUser, renderWithApp } from '../testUtils';
import { PermissionsTab } from './PermissionsTab';

const common = {
  loading: false,
  canManageAccess: true,
  allGroups: [],
  currentUser: makeUser(),
  client: null,
  permissionUsers: [makeUser()],
  capabilityPolicy: makeBranchPolicy(),
  onCapabilityPolicyChange: vi.fn(),
  workspacePreferences: { session_sharing_enabled: true },
} as const;

describe('PermissionsTab', () => {
  it('renders the canonical branch policy editor and immutable primary owner', () => {
    renderWithApp(<PermissionsTab {...common} />);

    expect(screen.getByText('Branch permissions')).toBeInTheDocument();
    expect(screen.getByLabelText('Primary owner for this branch')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Shared' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Add user/group' })).toBeInTheDocument();
    expect(screen.queryByText('Others Can')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('keeps access controls read only when the caller cannot manage policy', () => {
    renderWithApp(<PermissionsTab {...common} canManageAccess={false} />);

    expect(screen.getByRole('radio', { name: 'Private' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Shared' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add user/group' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Others fallback role' })).toBeDisabled();
  });

  it('renders a bounded loading skeleton until the normalized package arrives', () => {
    const { container } = renderWithApp(
      <PermissionsTab {...common} loading capabilityPolicy={null} />
    );

    expect(container.querySelector('.ant-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Branch permissions')).not.toBeInTheDocument();
  });

  it('fails closed with the permission load error', () => {
    renderWithApp(
      <PermissionsTab {...common} error={new Error('Permission package unavailable')} />
    );

    expect(screen.getByText('Permission package unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Branch permissions')).not.toBeInTheDocument();
  });
});
