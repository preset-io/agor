import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeBranch, makeBranchPolicy, makeStubClient, makeUser, wrapper } from './testUtils';
import { useBranchModalForm } from './useBranchModalForm';

describe('useBranchModalForm normalized permission package', () => {
  it('loads the immutable primary owner and grants that owner management', async () => {
    const owner = makeUser({ user_id: 'user-1', role: 'member' });
    const branch = makeBranch();
    const { client } = makeStubClient({ users: [owner] });
    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: owner, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.permissionsLoading).toBe(false));
    expect(result.current.capabilityPolicy?.primary_owner_user_id).toBe('user-1');
    expect(result.current.canViewPermissions).toBe(true);
    expect(result.current.canManagePolicy).toBe(true);
    expect(result.current.canEditGeneral).toBe(true);
  });

  it('uses server-resolved Manager access for policy, environment, and general controls', async () => {
    const manager = makeUser({ user_id: 'manager-1', role: 'member' });
    const branch = makeBranch();
    const { client } = makeStubClient({
      users: [manager],
      effectiveAccess: { can: 'all', is_owner: false, source: 'direct' },
    });
    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: manager, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.permissionsLoading).toBe(false));
    expect(result.current.canManagePolicy).toBe(true);
    expect(result.current.canControlEnvironment).toBe(true);
    expect(result.current.canEditGeneral).toBe(true);
  });

  it('lets a branch viewer edit only their personal sharing rule', async () => {
    const viewer = makeUser({ user_id: 'viewer-1', role: 'member' });
    const branch = makeBranch();
    const { client } = makeStubClient({
      users: [viewer],
      effectiveAccess: { can: 'view', is_owner: false, source: 'others' },
    });
    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: viewer, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.permissionsLoading).toBe(false));
    expect(result.current.canViewPermissions).toBe(true);
    expect(result.current.canManagePolicy).toBe(false);
    expect(result.current.canEditGeneral).toBe(false);
    expect(result.current.canEditPermissions).toBe(true);
  });

  it('saves general changes and the canonical permission package without legacy owner calls', async () => {
    const owner = makeUser({ user_id: 'user-1', role: 'member' });
    const branch = makeBranch();
    const { client, calls } = makeStubClient({ users: [owner] });
    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: owner, open: true }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.permissionsLoading).toBe(false));

    act(() => {
      result.current.setGeneral('notes', 'Updated notes');
      const changed = structuredClone(result.current.capabilityPolicy!);
      changed.override_config!.access.others = {
        preset: 'viewer',
        capabilities: ['branch.view'],
        fs_access: 'none',
      };
      result.current.setCapabilityPolicy(changed);
    });

    let saved: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toEqual({ ok: true });
    const mutations = calls.filter((call) => call.method === 'patch');
    expect(mutations.map((call) => call.service)).toEqual(['branches/:id/permissions', 'branches']);
    expect(calls.some((call) => call.service.includes('/owners'))).toBe(false);
    expect(calls.some((call) => call.service.includes('group-grants'))).toBe(false);
  });

  it('returns a failed save instead of closing over a branch update error', async () => {
    const owner = makeUser({ user_id: 'user-1', role: 'member' });
    const branch = makeBranch();
    const { client } = makeStubClient({ users: [owner], failBranchPatch: true });
    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: owner, open: true }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.permissionsLoading).toBe(false));
    act(() => result.current.setGeneral('notes', 'Will fail'));

    let saved: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBeDefined();
    if (!saved) throw new Error('Expected save result');
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.message).toBe('daemon exploded');
  });

  it('fails closed when the canonical permission package cannot load', async () => {
    const admin = makeUser({ user_id: 'admin-1', role: 'superadmin' });
    const branch = makeBranch();
    const { client } = makeStubClient({ failPermissionsFind: true });
    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: admin, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.permissionsLoading).toBe(false));
    expect(result.current.permissionsLoadError?.message).toContain('unavailable');
    expect(result.current.capabilityPolicy).toBeNull();
    expect(result.current.canViewPermissions).toBe(false);
    expect(result.current.canEditGeneral).toBe(false);
  });

  it('resets local permission edits to the last server package', async () => {
    const owner = makeUser({ user_id: 'user-1', role: 'member' });
    const branch = makeBranch();
    const original = makeBranchPolicy();
    const { client } = makeStubClient({ users: [owner], capabilityPolicy: original });
    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: owner, open: true }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.permissionsLoading).toBe(false));

    act(() => {
      const changed = structuredClone(result.current.capabilityPolicy!);
      changed.binding_mode = 'inherit';
      changed.inherited_config = structuredClone(changed.override_config!);
      delete changed.override_config;
      result.current.setCapabilityPolicy(changed);
    });
    expect(result.current.permissionsChanged).toBe(true);
    act(() => result.current.reset());
    expect(result.current.capabilityPolicy?.binding_mode).toBe('override');
    expect(result.current.permissionsChanged).toBe(false);
  });
});
