import { generateId } from '@agor/core/ids/browser';
import type { Branch } from '@agor-live/client';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { branchPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import { fakeFeathersClient, withTestAuthority } from '../../test/harness';
import { BranchModal } from './BranchModal';
import { makeBranch, makeBranchPolicy, makeRepo, makeUser, renderWithApp } from './testUtils';

withTestAuthority('user-1:admin:1');

it.each([false, true])(
  'keeps snapshot-modal notifications live without resetting drafts (archived=%s)',
  async (archived) => {
    const user = makeUser();
    const branch = makeBranch({
      archived,
      filesystem_status: 'ready',
      workspace_operation: {
        operation_id: generateId(),
        action: 'clean',
        filesystem_action: 'cleaned',
        status: 'succeeded',
        requested_by: user.user_id,
        requested_at: '2026-10-08T00:00:00Z',
        deadline_at: '2026-10-08T00:06:00Z',
        finished_at: '2026-10-08T00:01:00Z',
      },
    });
    branchPatched(branch);
    const { client, emit, calls } = fakeFeathersClient({
      branches: { get: () => branch },
      'branches/:id/owners': { find: () => [user] },
      'branches/:id/permissions': { find: () => makeBranchPolicy() },
      'branches/:id/effective-access': { find: () => ({ is_owner: true, can: 'all' }) },
      users: { findAll: () => [user] },
    });
    // Exercise the canonical realtime handler too: archived patches must not
    // populate the canvas map just to make an open modal's status reactive.
    const receivePatch = (updated: Branch) => {
      branchPatched(updated);
      emit('branches', 'patched', updated);
    };
    const mounted = renderWithApp(
      <BranchModal
        open
        onClose={() => {}}
        branch={branch}
        repo={makeRepo()}
        sessions={[]}
        currentUser={user}
        client={client}
      />
    );
    const notes = screen.getByPlaceholderText<HTMLTextAreaElement>(
      'Freeform notes about this branch...'
    );
    await waitFor(() => expect(notes.disabled).toBe(false));
    expect(
      calls
        .filter((call) => call.service === 'branches' && call.method === 'get')
        .map((call) => call.id)
    ).toEqual([branch.branch_id]);
    fireEvent.change(notes, { target: { value: 'Unsaved draft' } });
    expect(screen.getByText('Cleanup finished.')).not.toBeNull();

    act(() => receivePatch({ ...branch, branch_id: generateId(), workspace_operation: undefined }));
    expect(screen.getByText('Cleanup finished.')).not.toBeNull();

    // Another manager dismisses the outcome. The modal prop stays a snapshot.
    act(() => receivePatch({ ...branch, workspace_operation: undefined }));
    expect(screen.queryByText('Cleanup finished.')).toBeNull();
    expect(agorStore.getState().branchById.has(branch.branch_id)).toBe(!archived);
    expect(notes.value).toBe('Unsaved draft');

    act(() =>
      receivePatch({
        ...branch,
        workspace_operation: {
          ...branch.workspace_operation!,
          operation_id: generateId(),
          status: 'failed',
          error: 'New failure',
        },
      })
    );
    expect(screen.getByText("Agor couldn't clean up this branch's files.")).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('New failure')).not.toBeNull();
    expect(notes.value).toBe('Unsaved draft');
    mounted.unmount();
  }
);
