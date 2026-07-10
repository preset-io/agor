/**
 * Tests for the BranchModal unified form hook.
 *
 * The Branch / Teammate modal used to ship two independent Save buttons —
 * one inside the General tab (board, notes, MCP servers) and a second inside
 * the Owners & Permissions section (owners, others_can, fs access). That was
 * confusing. The hook here consolidates everything so a single Save action
 * commits General + Teammate + Permissions in one shot.
 *
 * What we pin:
 *   1. A single PATCH with both general-tab fields AND permission-tab fields
 *      when the user touched both slices.
 *   2. Owners add/remove diffs route to the nested owners service.
 *   3. PATCH failures bubble back as { ok: false } (no silent success).
 *   4. External branch updates do NOT create phantom dirty state for
 *      untouched slices.
 *   5. Teammate emoji → board icon side effect only fires when the emoji
 *      actually changed.
 *   6. RBAC-disabled instances don't trip permissionsChanged.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeBranch, makeStubClient, makeTeammateBranch, makeUser, wrapper } from './testUtils';
import { useBranchModalForm } from './useBranchModalForm';

describe('useBranchModalForm — unified save', () => {
  it('sends ONE branches.patch combining general + permission fields, plus owners diffs', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const bob = makeUser({ user_id: 'user-2', email: 'bob@example.com', role: 'member' });
    const branch = makeBranch();

    const { client, calls } = makeStubClient({ owners: [alice], users: [alice, bob] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    // Wait for owners + users to load
    await waitFor(() => {
      expect(result.current.loadingOwners).toBe(false);
      expect(result.current.owners.length).toBe(1);
    });

    expect(result.current.hasChanges).toBe(false);

    act(() => {
      result.current.setGeneral('notes', 'New notes for branch');
    });
    expect(result.current.generalChanged).toBe(true);

    act(() => {
      result.current.setPermissions('othersCan', 'prompt');
    });
    expect(result.current.permissionsChanged).toBe(true);

    act(() => {
      result.current.setPermissions('selectedOwnerIds', [
        ...result.current.permissions.selectedOwnerIds,
        'user-2',
      ]);
    });

    expect(result.current.hasChanges).toBe(true);

    let saveResult: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(saveResult).toEqual({ ok: true });

    // Owners service called once for the new owner (bob), no removes
    const ownerCreates = calls.filter(
      (c) => c.service === 'branches/:id/owners' && c.method === 'create'
    );
    expect(ownerCreates).toHaveLength(1);
    expect((ownerCreates[0].args[0] as { user_id: string }).user_id).toBe('user-2');

    const ownerRemoves = calls.filter(
      (c) => c.service === 'branches/:id/owners' && c.method === 'remove'
    );
    expect(ownerRemoves).toHaveLength(0);

    // Exactly ONE branches.patch carrying general + permissions fields
    const branchPatches = calls.filter((c) => c.service === 'branches' && c.method === 'patch');
    expect(branchPatches).toHaveLength(1);
    const [patchedId, patchedBody] = branchPatches[0].args as [string, Record<string, unknown>];
    expect(patchedId).toBe('branch-1');
    expect(patchedBody).toMatchObject({
      notes: 'New notes for branch',
      others_can: 'prompt',
      others_fs_access: 'read',
      dangerously_allow_session_sharing: false,
    });
  });

  it('returns ok:false when the branch PATCH fails (no silent success)', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    const { client } = makeStubClient({
      owners: [alice],
      users: [alice],
      failBranchPatch: true,
    });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    act(() => {
      result.current.setGeneral('notes', 'edited');
    });

    let saveResult: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(saveResult?.ok).toBe(false);
    if (saveResult && !saveResult.ok) {
      expect(saveResult.error.message).toBe('daemon exploded');
    }
    expect(result.current.saving).toBe(false);
  });

  it('refuses to save when the form ends up with zero owners (defensive guard)', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    const { client, calls } = makeStubClient({ owners: [alice], users: [alice] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    act(() => {
      result.current.setPermissions('selectedOwnerIds', []);
    });

    let saveResult: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(saveResult?.ok).toBe(false);
    // No branch.patch should have fired
    const branchPatches = calls.filter((c) => c.service === 'branches' && c.method === 'patch');
    expect(branchPatches).toHaveLength(0);
  });

  it('does not flag phantom dirty state when the branch prop refreshes for an untouched slice', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch({ notes: 'original' });
    const { client } = makeStubClient({ owners: [alice], users: [alice] });

    const { result, rerender } = renderHook(
      ({ branchProp }) =>
        useBranchModalForm({ branch: branchProp, client, currentUser: alice, open: true }),
      { wrapper, initialProps: { branchProp: branch } }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));
    expect(result.current.hasChanges).toBe(false);

    // Simulate a WebSocket update: same branch_id, but new prop reference
    // with a different value. The user hasn't touched the General slice, so
    // the form should silently absorb the new value and stay clean.
    const branchV2 = makeBranch({ notes: 'updated by someone else' });
    rerender({ branchProp: branchV2 });

    await waitFor(() => {
      expect(result.current.general.notes).toBe('updated by someone else');
    });
    expect(result.current.hasChanges).toBe(false);
  });

  it('preserves user edits across same-branch prop refreshes (touched slice wins)', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch({ notes: 'original' });
    const { client } = makeStubClient({ owners: [alice], users: [alice] });

    const { result, rerender } = renderHook(
      ({ branchProp }) =>
        useBranchModalForm({ branch: branchProp, client, currentUser: alice, open: true }),
      { wrapper, initialProps: { branchProp: branch } }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    // User types in the General tab
    act(() => {
      result.current.setGeneral('notes', 'my draft');
    });
    expect(result.current.general.notes).toBe('my draft');

    // WebSocket update arrives for the same branch_id — should NOT trample
    // the user's in-flight edits.
    const branchV2 = makeBranch({ notes: 'concurrent edit by someone else' });
    rerender({ branchProp: branchV2 });

    expect(result.current.general.notes).toBe('my draft');
    expect(result.current.generalChanged).toBe(true);
  });

  it('updates board icon only when teammate emoji actually changed', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeTeammateBranch({}, { emoji: '🤖' });
    const { client, calls } = makeStubClient({ owners: [alice], users: [alice] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    // Change only the display name, leave emoji alone
    act(() => {
      result.current.setTeammate('displayName', 'Renamed Teammate');
    });

    await act(async () => {
      await result.current.save();
    });

    const boardPatches = calls.filter((c) => c.service === 'boards' && c.method === 'patch');
    expect(boardPatches).toHaveLength(0);
  });

  it('does patch the board icon when teammate emoji actually changed', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeTeammateBranch({}, { emoji: '🤖' });
    const { client, calls } = makeStubClient({ owners: [alice], users: [alice] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    act(() => {
      result.current.setTeammate('emoji', '🎯');
    });

    await act(async () => {
      await result.current.save();
    });

    const boardPatches = calls.filter((c) => c.service === 'boards' && c.method === 'patch');
    expect(boardPatches).toHaveLength(1);
    const [, body] = boardPatches[0].args as [string, Record<string, unknown>];
    expect(body).toMatchObject({ icon: '🎯' });
  });

  it('does NOT call branches.patch for an owner-only transfer (no permission-field churn)', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const bob = makeUser({ user_id: 'user-2', email: 'bob@example.com', role: 'member' });
    const branch = makeBranch();
    const { client, calls } = makeStubClient({ owners: [alice], users: [alice, bob] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    // Pure owner transfer: Alice → Bob. No permission-field change.
    act(() => {
      result.current.setPermissions('selectedOwnerIds', ['user-2']);
    });
    expect(result.current.permissionsChanged).toBe(true);

    await act(async () => {
      await result.current.save();
    });

    // Owners service ran the add + remove
    const ownerCreates = calls.filter(
      (c) => c.service === 'branches/:id/owners' && c.method === 'create'
    );
    const ownerRemoves = calls.filter(
      (c) => c.service === 'branches/:id/owners' && c.method === 'remove'
    );
    expect(ownerCreates).toHaveLength(1);
    expect(ownerRemoves).toHaveLength(1);

    // The branch row should NOT have been touched — sending unchanged
    // permission fields would force a redundant auth check that the
    // about-to-be-removed owner might fail.
    const branchPatches = calls.filter((c) => c.service === 'branches' && c.method === 'patch');
    expect(branchPatches).toHaveLength(0);
  });

  it('orders owner-transfer + permission change as: add → branches.patch → remove', async () => {
    // Pinpoints the must-fix from the second review pass: the about-to-be-
    // removed owner has to still be authorized when branches.patch fires.
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const bob = makeUser({ user_id: 'user-2', email: 'bob@example.com', role: 'member' });
    const branch = makeBranch();
    const { client, calls } = makeStubClient({ owners: [alice], users: [alice, bob] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    act(() => {
      result.current.setPermissions('selectedOwnerIds', ['user-2']);
      result.current.setPermissions('othersCan', 'all');
    });

    await act(async () => {
      await result.current.save();
    });

    // Filter to just the mutating operations on permissions + branches
    const mutations = calls.filter(
      (c) =>
        (c.service === 'branches/:id/owners' && (c.method === 'create' || c.method === 'remove')) ||
        (c.service === 'branches' && c.method === 'patch')
    );

    expect(mutations.map((c) => `${c.service}.${c.method}`)).toEqual([
      'branches/:id/owners.create', // Bob added first
      'branches.patch', // PATCH while Alice is still an owner
      'branches/:id/owners.remove', // Alice removed last
    ]);
  });

  it('surfaces non-404 owners-load failures via ownersLoadError instead of going silent', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    const { client } = makeStubClient({ failOwnersFind: true });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.loadingOwners).toBe(false);
      expect(result.current.ownersLoadError).not.toBeNull();
    });

    expect(result.current.ownersLoadError?.message).toBe('database is down');
    expect(result.current.groupGrantsStatus).toBe('unavailable');
    expect(result.current.groupGrantsError?.message).toBe('database is down');
    // RBAC stays "enabled" so the modal doesn't silently flip into the
    // open-access mode based on an unrelated network blip.
    expect(result.current.rbacEnabled).toBe(true);
  });

  it('enables owner-editable permissions before slow group grants finish loading', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    let resolveGroupGrants: (value: unknown[]) => void = () => {};
    const groupGrantsPromise = new Promise<unknown[]>((resolve) => {
      resolveGroupGrants = resolve;
    });
    const { client } = makeStubClient({
      owners: [alice],
      users: [alice],
      groupGrantsPromise,
    });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.loadingOwners).toBe(false);
      expect(result.current.groupGrantsStatus).toBe('loading');
    });

    expect(result.current.canEditPermissions).toBe(true);

    await act(async () => {
      resolveGroupGrants([]);
      await groupGrantsPromise;
    });

    await waitFor(() => expect(result.current.groupGrantsStatus).toBe('loaded'));
  });

  it('keeps admin permissions visible when group-aware RBAC metadata is unavailable', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    const { client } = makeStubClient({ owners: [alice], users: [alice], groupGrants404: true });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    expect(result.current.rbacEnabled).toBe(true);
    expect(result.current.canViewPermissions).toBe(true);
    expect(result.current.canEditPermissions).toBe(true);
    expect(result.current.groupGrantsStatus).toBe('unavailable');
    expect(result.current.groupGrantsError?.message).toBe('not found');
  });

  it('allows admins to view but not edit permissions when owner rows are incomplete', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    const { client } = makeStubClient({ owners: [], users: [alice] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    expect(result.current.canViewPermissions).toBe(true);
    expect(result.current.canEditPermissions).toBe(false);
  });

  it('hides permissions from non-admin users who are not branch owners after owners load', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'member' });
    const bob = makeUser({ user_id: 'user-2', email: 'bob@example.com', role: 'member' });
    const branch = makeBranch();
    const { client } = makeStubClient({ owners: [bob], users: [alice, bob] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    expect(result.current.canViewPermissions).toBe(false);
    expect(result.current.canEditPermissions).toBe(false);
  });

  it('allows environment control from server-resolved effective all permission', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'member' });
    const bob = makeUser({ user_id: 'user-2', email: 'bob@example.com', role: 'member' });
    const branch = makeBranch({
      created_by: 'user-2',
      others_can: 'view',
    });
    const { client } = makeStubClient({
      owners: [bob],
      users: [alice, bob],
      effectiveAccess: { can: 'all', is_owner: false, source: 'group' },
    });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    expect(result.current.canViewPermissions).toBe(false);
    expect(result.current.canEditPermissions).toBe(false);
    expect(result.current.canControlEnvironment).toBe(true);
  });

  it('shows permissions for teammate branches when the current admin is an owner', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeTeammateBranch();
    const { client } = makeStubClient({ owners: [alice], users: [alice] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    expect(result.current.canViewPermissions).toBe(true);
    expect(result.current.canEditPermissions).toBe(true);
  });

  it('detects no permission changes when RBAC is disabled (404 from owners service)', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    const { client } = makeStubClient({ rbac404: true });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.loadingOwners).toBe(false);
      expect(result.current.rbacEnabled).toBe(false);
      expect(result.current.canViewPermissions).toBe(false);
    });

    expect(result.current.permissionsChanged).toBe(false);
    expect(result.current.hasChanges).toBe(false);
  });
});
