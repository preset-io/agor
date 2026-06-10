/**
 * PermissionsTab — rendering tests.
 *
 * The tab is a controlled view: it never owns save state, just renders the
 * RBAC controls and forwards changes through `setField`. These tests pin
 * the visible behaviors that matter to users.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeUser, renderWithApp } from '../testUtils';
import type { PermissionsFormState } from '../useBranchModalForm';
import { PermissionsTab } from './PermissionsTab';

const defaultState: PermissionsFormState = {
  selectedOwnerIds: ['user-1'],
  othersCan: 'session',
  othersFsAccess: 'read',
  allowSessionSharing: false,
  groupGrants: [],
};

describe('PermissionsTab', () => {
  it('renders owners + permission controls', () => {
    renderWithApp(
      <PermissionsTab
        loadingOwners={false}
        canEdit={true}
        allUsers={[makeUser()]}
        currentUser={makeUser()}
        state={defaultState}
        setField={vi.fn()}
      />
    );
    expect(screen.getByText('Permission Mode')).toBeInTheDocument();
    expect(screen.getByText('Owners')).toBeInTheDocument();
    expect(screen.getByText('Others Can')).toBeInTheDocument();
    expect(screen.getByText('Filesystem Access')).toBeInTheDocument();
    expect(screen.getByText('Allow legacy session sharing')).toBeInTheDocument();
  });

  it('shows the unix-identity warning when others_can = prompt', () => {
    renderWithApp(
      <PermissionsTab
        loadingOwners={false}
        canEdit={true}
        allUsers={[makeUser()]}
        currentUser={makeUser()}
        state={{ ...defaultState, othersCan: 'prompt' }}
        setField={vi.fn()}
      />
    );
    expect(screen.getByText('Unix identity risk')).toBeInTheDocument();
  });

  it('shows the dangerous warning when legacy session sharing is on', () => {
    renderWithApp(
      <PermissionsTab
        loadingOwners={false}
        canEdit={true}
        allUsers={[makeUser()]}
        currentUser={makeUser()}
        state={{ ...defaultState, allowSessionSharing: true }}
        setField={vi.fn()}
      />
    );
    expect(screen.getByText(/Dangerous: identity borrowing/i)).toBeInTheDocument();
  });

  it('toggles allowSessionSharing through setField', () => {
    const setField = vi.fn();
    renderWithApp(
      <PermissionsTab
        loadingOwners={false}
        canEdit={true}
        allUsers={[makeUser()]}
        currentUser={makeUser()}
        state={defaultState}
        setField={setField}
      />
    );

    const sharingSwitch = screen.getByRole('switch');
    fireEvent.click(sharingSwitch);
    expect(setField).toHaveBeenCalledWith('allowSessionSharing', true);
  });

  it('does NOT render a Save button — save lives at the modal level', () => {
    renderWithApp(
      <PermissionsTab
        loadingOwners={false}
        canEdit={true}
        allUsers={[makeUser()]}
        currentUser={makeUser()}
        state={{ ...defaultState, othersCan: 'prompt' }}
        setField={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });

  it('disables all controls when canEdit is false', () => {
    renderWithApp(
      <PermissionsTab
        loadingOwners={false}
        canEdit={false}
        allUsers={[makeUser()]}
        currentUser={makeUser()}
        state={defaultState}
        setField={vi.fn()}
      />
    );
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('warns when group permissions are unavailable without hiding branch-level controls', () => {
    renderWithApp(
      <PermissionsTab
        loadingOwners={false}
        canEdit={true}
        allUsers={[makeUser()]}
        currentUser={makeUser()}
        state={defaultState}
        setField={vi.fn()}
        groupGrantsStatus="unavailable"
        groupGrantsError={new Error('not found')}
      />
    );

    expect(screen.getByText('Group permissions unavailable')).toBeInTheDocument();
    expect(screen.getByText('Others Can')).toBeInTheDocument();
    expect(screen.getByText('Filesystem Access')).toBeInTheDocument();
  });
});
