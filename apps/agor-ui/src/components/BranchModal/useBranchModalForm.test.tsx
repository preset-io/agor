/**
 * Tests for the BranchModal unified form hook.
 *
 * The Branch / Assistant modal used to ship two independent Save buttons —
 * one inside the General tab (board, notes, MCP servers) and a second inside
 * the Owners & Permissions section (owners, others_can, fs access). That was
 * confusing. The hook here consolidates everything so a single Save action
 * commits General + Assistant + Permissions in one shot.
 *
 * What we pin:
 *   1. A single PATCH with both general-tab fields AND permission-tab fields
 *      when the user touched both slices.
 *   2. Owners add/remove diffs route to the nested owners service.
 *   3. PATCH failures bubble back as { ok: false } (no silent success).
 *   4. External branch updates do NOT create phantom dirty state for
 *      untouched slices.
 *   5. Assistant emoji → board icon side effect only fires when the emoji
 *      actually changed.
 *   6. RBAC-disabled instances don't trip permissionsChanged.
 */

import type { AgorClient, AssistantConfig, Branch, User } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useBranchModalForm } from './useBranchModalForm';

function wrapper({ children }: { children: ReactNode }) {
  return <AntApp>{children}</AntApp>;
}

interface ServiceCall {
  service: string;
  method: 'find' | 'create' | 'patch' | 'remove' | 'findAll';
  args: unknown[];
}

interface StubOptions {
  owners?: User[];
  users?: User[];
  rbac404?: boolean;
  failBranchPatch?: boolean;
  /** Throw a 500-style error on the initial owners.find load. */
  failOwnersFind?: boolean;
}

function makeStubClient(opts: StubOptions = {}): { client: AgorClient; calls: ServiceCall[] } {
  const owners = [...(opts.owners ?? [])];
  const users = opts.users ?? [];
  const calls: ServiceCall[] = [];

  const client = {
    service(path: string) {
      return {
        async find(args: unknown) {
          calls.push({ service: path, method: 'find', args: [args] });
          if (path === 'branches/:id/owners') {
            if (opts.rbac404) {
              const err = new Error('not found') as Error & { code?: number };
              err.code = 404;
              throw err;
            }
            if (opts.failOwnersFind) {
              const err = new Error('database is down') as Error & { code?: number };
              err.code = 500;
              throw err;
            }
            return owners;
          }
          return [];
        },
        async findAll(args: unknown) {
          calls.push({ service: path, method: 'findAll', args: [args] });
          if (path === 'users') return users;
          return [];
        },
        async create(body: unknown, params?: unknown) {
          calls.push({ service: path, method: 'create', args: [body, params] });
          if (path === 'branches/:id/owners') {
            const userId = (body as { user_id: string }).user_id;
            const newUser = users.find((u) => u.user_id === userId);
            if (newUser) owners.push(newUser);
            return newUser ?? { user_id: userId };
          }
          return body;
        },
        async patch(id: string, body: unknown, params?: unknown) {
          calls.push({ service: path, method: 'patch', args: [id, body, params] });
          if (path === 'branches' && opts.failBranchPatch) {
            throw new Error('daemon exploded');
          }
          return { ...(body as object), branch_id: id };
        },
        async remove(id: string, params?: unknown) {
          calls.push({ service: path, method: 'remove', args: [id, params] });
          if (path === 'branches/:id/owners') {
            const idx = owners.findIndex((o) => o.user_id === id);
            if (idx >= 0) owners.splice(idx, 1);
          }
          return { user_id: id };
        },
      };
    },
  } as unknown as AgorClient;

  return { client, calls };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'alice@example.com',
    role: 'admin',
    ...overrides,
  } as unknown as User;
}

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'branch-1',
    name: 'feature/foo',
    repo_id: 'repo-1',
    board_id: undefined,
    issue_url: undefined,
    pull_request_url: undefined,
    notes: '',
    mcp_server_ids: [],
    others_can: 'session',
    others_fs_access: 'read',
    dangerously_allow_session_sharing: false,
    ...overrides,
  } as unknown as Branch;
}

function makeAssistantBranch(
  overrides: Partial<Branch> = {},
  configOverrides: Partial<AssistantConfig> = {}
): Branch {
  return makeBranch({
    board_id: 'board-1',
    custom_context: {
      assistant: {
        kind: 'assistant',
        displayName: 'My Assistant',
        emoji: '🤖',
        ...configOverrides,
      } as AssistantConfig,
    },
    ...overrides,
  });
}

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

  it('updates board icon only when assistant emoji actually changed', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeAssistantBranch({}, { emoji: '🤖' });
    const { client, calls } = makeStubClient({ owners: [alice], users: [alice] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    // Change only the display name, leave emoji alone
    act(() => {
      result.current.setAssistant('displayName', 'Renamed Assistant');
    });

    await act(async () => {
      await result.current.save();
    });

    const boardPatches = calls.filter((c) => c.service === 'boards' && c.method === 'patch');
    expect(boardPatches).toHaveLength(0);
  });

  it('does patch the board icon when assistant emoji actually changed', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeAssistantBranch({}, { emoji: '🤖' });
    const { client, calls } = makeStubClient({ owners: [alice], users: [alice] });

    const { result } = renderHook(
      () => useBranchModalForm({ branch, client, currentUser: alice, open: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    act(() => {
      result.current.setAssistant('emoji', '🎯');
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
    // RBAC stays "enabled" so the modal doesn't silently flip into the
    // open-access mode based on an unrelated network blip.
    expect(result.current.rbacEnabled).toBe(true);
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
    });

    expect(result.current.permissionsChanged).toBe(false);
    expect(result.current.hasChanges).toBe(false);
  });
});
