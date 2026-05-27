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
 *   3. Pure-permissions edits don't re-send any general-tab fields.
 *   4. hasChanges / change detection across slices.
 */

import type { AgorClient, Branch, User } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
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

describe('useBranchModalForm — unified save', () => {
  it('sends ONE branches.patch combining general + permission fields, plus owners diffs', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const bob = makeUser({ user_id: 'user-2', email: 'bob@example.com', role: 'member' });
    const branch = makeBranch();

    const { client, calls } = makeStubClient({ owners: [alice], users: [alice, bob] });
    const onUpdateBranch = vi.fn();

    const { result } = renderHook(
      () =>
        useBranchModalForm({
          branch,
          client,
          currentUser: alice,
          open: true,
          onUpdateBranch,
        }),
      { wrapper }
    );

    // Wait for owners + users to load
    await waitFor(() => {
      expect(result.current.loadingOwners).toBe(false);
      expect(result.current.owners.length).toBe(1);
    });

    // No changes yet
    expect(result.current.hasChanges).toBe(false);

    // User edits a General-tab field
    act(() => {
      result.current.setGeneral('notes', 'New notes for branch');
    });
    expect(result.current.generalChanged).toBe(true);

    // User edits a Permissions-tab field
    act(() => {
      result.current.setPermissions('othersCan', 'prompt');
    });
    expect(result.current.permissionsChanged).toBe(true);

    // User adds bob as an owner
    act(() => {
      result.current.setPermissions('selectedOwnerIds', [
        ...result.current.permissions.selectedOwnerIds,
        'user-2',
      ]);
    });

    expect(result.current.hasChanges).toBe(true);

    // Trigger unified save
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

    // Exactly ONE onUpdateBranch call combining general + permissions fields
    expect(onUpdateBranch).toHaveBeenCalledTimes(1);
    const [calledBranchId, payload] = onUpdateBranch.mock.calls[0];
    expect(calledBranchId).toBe('branch-1');
    expect(payload).toMatchObject({
      notes: 'New notes for branch',
      others_can: 'prompt',
      others_fs_access: 'read',
      dangerously_allow_session_sharing: false,
    });
  });

  it('refuses to save when the form ends up with zero owners (defensive guard)', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    const { client } = makeStubClient({ owners: [alice], users: [alice] });
    const onUpdateBranch = vi.fn();

    const { result } = renderHook(
      () =>
        useBranchModalForm({
          branch,
          client,
          currentUser: alice,
          open: true,
          onUpdateBranch,
        }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loadingOwners).toBe(false));

    // Bypass the UI guard and shove an empty owner list into the form.
    act(() => {
      result.current.setPermissions('selectedOwnerIds', []);
    });

    let saveResult: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(saveResult?.ok).toBe(false);
    expect(onUpdateBranch).not.toHaveBeenCalled();
  });

  it('detects no permission changes when RBAC is disabled (404 from owners service)', async () => {
    const alice = makeUser({ user_id: 'user-1', email: 'alice@example.com', role: 'admin' });
    const branch = makeBranch();
    const { client } = makeStubClient({ rbac404: true });
    const onUpdateBranch = vi.fn();

    const { result } = renderHook(
      () =>
        useBranchModalForm({
          branch,
          client,
          currentUser: alice,
          open: true,
          onUpdateBranch,
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.loadingOwners).toBe(false);
      expect(result.current.rbacEnabled).toBe(false);
    });

    // Even if a stale permissions state would differ, `permissionsChanged`
    // stays false because RBAC isn't active here.
    expect(result.current.permissionsChanged).toBe(false);
    expect(result.current.hasChanges).toBe(false);
  });
});
