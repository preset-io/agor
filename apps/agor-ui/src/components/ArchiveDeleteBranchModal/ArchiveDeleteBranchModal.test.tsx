import { branchMaintenanceCapabilities } from '@agor/core/config/browser';
import type {
  AgorClient,
  Board,
  EffectiveBranchAccess,
  EffectiveCapabilityPolicyAccess,
  Repo,
} from '@agor-live/client';
import { DEFAULT_REPO_CLEANUP_POLICY } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { makeBranch, makeRepo, makeUser } from '../BranchModal/testUtils';
import { ArchiveDeleteBranchModal } from './ArchiveDeleteBranchModal';

function fixture(enabled = false) {
  const branch = makeBranch({
    maintenance_capabilities: branchMaintenanceCapabilities({}, 'clone'),
  });
  let repo = makeRepo({
    name: 'Test repo',
    cleanup_policy: { ...DEFAULT_REPO_CLEANUP_POLICY, enabled },
  });
  const listeners = new Set<(value: Repo) => void>();
  const repos = {
    get: vi.fn(async () => repo),
    patch: vi.fn(async (_id: string, data: Partial<Repo>) => {
      repo = { ...repo, ...data };
      for (const listener of listeners) listener(repo);
      return repo;
    }),
    on: (_event: string, listener: (value: Repo) => void) => listeners.add(listener),
    removeListener: (_event: string, listener: (value: Repo) => void) => listeners.delete(listener),
  };
  const branches = { get: vi.fn(async () => branch), on: vi.fn(), removeListener: vi.fn() };
  const boards = { get: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  const access = {
    find: vi.fn(
      async (): Promise<EffectiveBranchAccess> => ({
        can: 'all',
        fs_access: 'write',
        is_owner: true,
        source: 'owner',
      })
    ),
  };
  const services = { repos, branches, boards, 'branches/:id/effective-access': access };
  const client = {
    service: (path: keyof typeof services) => services[path],
  } as unknown as AgorClient;
  return { branch, repos, client, access };
}

it('defaults to Preserve when disabled, saves settings above archive, and refreshes the untouched default without submitting', async () => {
  const { client, branch, repos } = fixture();
  const confirm = vi.fn();
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role: 'admin' })}
      branch={branch}
      open
      onConfirm={confirm}
      onCancel={vi.fn()}
    />
  );
  expect(
    await screen.findByText(
      'Cleanup is disabled for this repository. Archiving will keep workspace files on disk.'
    )
  ).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /^Leave untouched/ })).toBeChecked();
  expect(screen.getByRole('radio', { name: /Clean —/ })).toBeDisabled();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Open repository settings' })).toBeVisible()
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open repository settings' }));
  const settingsTitle = await screen.findByText(/Repository settings —/);
  const settings = settingsTitle.closest('[role="dialog"]') as HTMLElement;
  fireEvent.click(within(settings).getByRole('button', { name: /Branch cleanup/ }));
  fireEvent.click(within(settings).getByRole('checkbox', { name: 'Enable branch cleanup' }));
  fireEvent.change(within(settings).getByLabelText('Cleanup command'), {
    target: { value: 'git clean -fdX' },
  });
  fireEvent.click(within(settings).getByRole('button', { name: /Branch cleanup/ }));
  fireEvent.click(within(settings).getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(repos.patch).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /Clean — git clean -fdX/ })).toBeChecked()
  );
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => {
    await repos.patch('unused', {
      cleanup_policy: { ...DEFAULT_REPO_CLEANUP_POLICY, enabled: true, command: './detached.sh' },
    });
  });
  await waitFor(() => expect(screen.getByRole('radio', { name: /Clean —/ })).toBeDisabled());
  expect(screen.getByRole('radio', { name: /^Leave untouched/ })).toBeChecked();
  expect(screen.getAllByText(/Custom cleanup commands are unavailable/).length).toBeGreaterThan(0);
});

it('does not steal explicit Preserve, falls back when protection changes, and fails closed on load failure', async () => {
  const { client, branch, repos } = fixture(true);
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role: 'admin' })}
      branch={branch}
      open
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );
  await waitFor(() => expect(screen.getByRole('radio', { name: /Clean —/ })).toBeEnabled());
  await waitFor(() => expect(screen.getByRole('radio', { name: /Clean —/ })).toBeChecked());
  expect(
    screen.getByText(/When enabled, this command runs when branch cleanup is requested/)
  ).toBeInTheDocument();
  expect(screen.queryByText('Cleanup deletes files; there is no undo')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: /^Leave untouched/ }));
  await act(async () => {
    await repos.patch('unused', {
      cleanup_policy: { ...DEFAULT_REPO_CLEANUP_POLICY, enabled: true, command: 'git clean -fdX' },
    });
  });
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /Clean — git clean -fdX/ })).toBeEnabled()
  );
  expect(screen.getByRole('radio', { name: /^Leave untouched/ })).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: /Clean —/ }));
  branch.cleanup_protected = true;
  await act(async () => {
    await repos.patch('unused', {});
  });
  await waitFor(() => expect(screen.getByRole('radio', { name: /Clean —/ })).toBeDisabled());
  expect(screen.getByRole('radio', { name: /^Leave untouched/ })).toBeChecked();
  repos.get.mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => {
    await repos.patch('unused', {});
  });
  await waitFor(() =>
    expect(
      screen.getAllByText('Cleanup policy or permissions could not be loaded.').length
    ).toBeGreaterThan(0)
  );
  expect(screen.getByRole('radio', { name: /Clean —/ })).toBeDisabled();
});

it('does not offer executable configuration to a non-admin or execution to a read-only Manager', async () => {
  const { client, branch, access } = fixture(true);
  access.find.mockResolvedValue({
    can: 'all',
    fs_access: 'read',
    is_owner: false,
    source: 'group',
  });
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role: 'member' })}
      branch={branch}
      open
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );
  await waitFor(() => expect(screen.getByRole('radio', { name: /Clean —/ })).toBeDisabled());
  expect(
    screen.queryByRole('button', { name: 'Open repository settings' })
  ).not.toBeInTheDocument();
});

it('permanent deletion always removes files, independent of cleanup policy and archive selection', async () => {
  const { client, branch } = fixture();
  const confirm = vi.fn();
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role: 'admin' })}
      branch={branch}
      open
      onConfirm={confirm}
      onCancel={vi.fn()}
    />
  );
  await screen.findByText(
    'Cleanup is disabled for this repository. Archiving will keep workspace files on disk.'
  );
  fireEvent.click(screen.getByRole('radio', { name: /^Delete permanently/ }));
  expect(screen.getByRole('radio', { name: /Delete completely/ })).toBeChecked();
  expect(screen.getByRole('radio', { name: /^Leave untouched/ })).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Open repository settings' })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
  expect(confirm).toHaveBeenLastCalledWith({
    metadataAction: 'delete',
    filesystemAction: 'deleted',
  });
  fireEvent.click(screen.getByRole('radio', { name: /Archive \(recommended\)/ }));
  expect(screen.getByRole('radio', { name: /^Leave untouched/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
  expect(confirm).toHaveBeenLastCalledWith({
    metadataAction: 'archive',
    filesystemAction: 'preserved',
  });
});

it('a failed deletion cannot be changed back into archive', async () => {
  const { client, branch } = fixture(true);
  branch.deletion_status = 'deletion_failed';
  const confirm = vi.fn();
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role: 'admin' })}
      branch={branch}
      open
      onConfirm={confirm}
      onCancel={vi.fn()}
    />
  );
  await screen.findByText("Agor couldn't finish deleting this branch.");
  expect(screen.getByRole('radio', { name: /Archive \(recommended\)/ })).toBeDisabled();
  expect(screen.getByRole('radio', { name: /Delete completely/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
  expect(confirm).toHaveBeenCalledWith({ metadataAction: 'delete', filesystemAction: 'deleted' });
});

it('an in-progress deletion uses the card notice and is read-only', async () => {
  const { client, branch } = fixture(true);
  branch.deletion_status = 'deleting';
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role: 'admin' })}
      branch={branch}
      open
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );
  expect(await screen.findByText('Agor is deleting this branch…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled();
});

it('does not promise to preserve files when archive explicitly removes the workspace', async () => {
  const { client, branch } = fixture();
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role: 'admin' })}
      branch={branch}
      open
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );
  await screen.findByText(
    'Cleanup is disabled for this repository. Archiving will keep workspace files on disk.'
  );
  fireEvent.click(screen.getByRole('radio', { name: /Delete completely/ }));
  expect(screen.queryByText(/Archiving will keep workspace files/)).not.toBeInTheDocument();
  expect(screen.getAllByText('Cleanup is disabled for this repository.').length).toBeGreaterThan(0);
});

// Match the effective-access service wire contract, not locally inferred ownership.
it.each([
  [
    'primary owner without ACLs',
    'member',
    { can: 'all', is_owner: true, source: 'owner', fs_access: 'write' },
    true,
  ],
  [
    'configured superadmin projection',
    'superadmin',
    { can: 'all', is_owner: false, source: 'superadmin', fs_access: 'write' },
    true,
  ],
  [
    'direct Manager',
    'member',
    { can: 'all', is_owner: false, source: 'others', fs_access: 'write' },
    true,
  ],
  [
    'group Manager',
    'member',
    { can: 'all', is_owner: false, source: 'group', fs_access: 'write' },
    true,
  ],
  [
    'Collaborator with write',
    'member',
    { can: 'prompt', is_owner: false, source: 'others', fs_access: 'write' },
    false,
  ],
  [
    'Viewer',
    'member',
    { can: 'view', is_owner: false, source: 'others', fs_access: 'read' },
    false,
  ],
  [
    'former owner/creator',
    'member',
    { can: 'none', is_owner: false, source: 'others', fs_access: 'none' },
    false,
  ],
  [
    'missing filesystem projection',
    'superadmin',
    { can: 'all', is_owner: false, source: 'superadmin' },
    false,
  ],
  [
    'admin without branch authority',
    'admin',
    { can: 'view', is_owner: false, source: 'others', fs_access: 'write' },
    false,
  ],
] as const)('uses authenticated access for %s', async (_label, role, effective, eligible) => {
  const { client, branch, access } = fixture(true);
  access.find.mockResolvedValue(effective);
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role })}
      branch={branch}
      open
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );
  expect(screen.getByRole('radio', { name: /Clean —/ })).toBeDisabled();
  await waitFor(() =>
    expect(screen.queryByText('Loading cleanup policy and permissions…')).not.toBeInTheDocument()
  );
  const clean = screen.getByRole('radio', { name: /Clean —/ });
  if (eligible) expect(clean).toBeEnabled();
  else expect(clean).toBeDisabled();
  if (effective.can !== 'all')
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled();
});

it.each(['none', 'read'] as const)(
  'Manager with %s files may Preserve but cannot Clean or Delete',
  async (fs_access) => {
    const { client, branch, access } = fixture(true);
    access.find.mockResolvedValue({ can: 'all', is_owner: false, source: 'group', fs_access });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
    expect(screen.getByRole('radio', { name: /Clean —/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Delete completely/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Delete permanently/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'archive',
      filesystemAction: 'preserved',
    });
  }
);

it('after refreshing eligibility, revoked or failed permissions disable all submissions, not just Clean', async () => {
  const { client, branch, access, repos } = fixture(true);
  const confirm = vi.fn();
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser({ role: 'member' })}
      branch={branch}
      open
      onConfirm={confirm}
      onCancel={vi.fn()}
    />
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled());
  fireEvent.click(screen.getByRole('radio', { name: /Delete permanently/ }));
  access.find.mockResolvedValue({
    can: 'view',
    is_owner: false,
    source: 'others',
    fs_access: 'read',
  });
  await act(async () => {
    await repos.patch('unused', {});
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled()
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
  expect(confirm).not.toHaveBeenCalled();
  access.find.mockRejectedValue(new Error('Forbidden'));
  await act(async () => {
    await repos.patch('unused', {});
  });
  await screen.findAllByText('Branch permissions could not be loaded.');
  expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled();
});

it.each(['disabled', 'missing'] as const)(
  'blocks %s permanent deletion before confirmation without changing it to archive',
  async (state) => {
    const { client, branch } = fixture();
    branch.maintenance_capabilities =
      state === 'missing'
        ? undefined
        : branchMaintenanceCapabilities({ execution: { unix_user_mode: 'delegated' } }, 'clone');
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser()}
        branch={branch}
        open
        initialMetadataAction="delete"
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(
        screen.getAllByText(
          state === 'missing' ? /upgrade the daemon/ : /verify the deletion storage mount contract/
        ).length
      ).toBeGreaterThan(0)
    );
    expect(screen.getByRole('radio', { name: /^Delete permanently/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
    expect(confirm).not.toHaveBeenCalled();
  }
);

it('allows clone archive removal while permanent deletion is disabled, and keeps preserve available for external worktrees', async () => {
  const { client, branch, repos } = fixture(true);
  const config = { execution: { unix_user_mode: 'delegated' as const } };
  branch.maintenance_capabilities = branchMaintenanceCapabilities(config, 'clone');
  const confirm = vi.fn();
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser()}
      branch={branch}
      open
      onConfirm={confirm}
      onCancel={vi.fn()}
    />
  );
  await waitFor(() => expect(screen.getByRole('radio', { name: /Clean —/ })).toBeEnabled());
  expect(screen.getByRole('radio', { name: /^Delete permanently/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /Delete completely/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
  expect(confirm).toHaveBeenCalledWith({ metadataAction: 'archive', filesystemAction: 'deleted' });
  branch.maintenance_capabilities = branchMaintenanceCapabilities(config, 'worktree');
  await act(async () => {
    await repos.patch('unused', {});
  });
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /Delete completely/ })).toBeDisabled()
  );
  // An explicit destructive selection is not silently changed into preserve.
  expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /^Leave untouched/ }));
  expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled();
});

it('describes permanent file deletion independently of unsupported archive removal', async () => {
  const { client, branch } = fixture();
  branch.maintenance_capabilities = branchMaintenanceCapabilities(
    { execution: { unix_user_mode: 'delegated', delegated_branch_deletion: true } },
    'worktree'
  );
  const confirm = vi.fn();
  render(
    <ArchiveDeleteBranchModal
      client={client}
      currentUser={makeUser()}
      branch={branch}
      open
      initialMetadataAction="delete"
      onConfirm={confirm}
      onCancel={vi.fn()}
    />
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeEnabled()
  );
  expect(
    screen.getByRole('radio', {
      name: 'Delete completely Removes workspace, branch SDK home, and owned uploads',
    })
  ).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
  expect(confirm).toHaveBeenCalledWith({ metadataAction: 'delete', filesystemAction: 'deleted' });
  fireEvent.click(screen.getByRole('radio', { name: /Archive \(recommended\)/ }));
  expect(
    screen.getByRole('radio', { name: /Delete completely External workspace cleanup/ })
  ).toBeDisabled();
});

function boardFixture(options?: {
  branchOverrides?: Partial<ReturnType<typeof makeBranch>>;
  board?: Board | null;
  boardAccess?: Partial<EffectiveCapabilityPolicyAccess>;
  branchAccess?: Partial<EffectiveBranchAccess>;
  cleanupEnabled?: boolean;
}) {
  const branch = makeBranch({
    maintenance_capabilities: branchMaintenanceCapabilities({}, 'clone'),
    board_id: 'board-1',
    ...options?.branchOverrides,
  });
  let repo = makeRepo({
    name: 'Test repo',
    cleanup_policy: { ...DEFAULT_REPO_CLEANUP_POLICY, enabled: options?.cleanupEnabled ?? false },
  });
  const listeners = new Set<(value: Repo) => void>();
  const repos = {
    get: vi.fn(async () => repo),
    patch: vi.fn(async (_id: string, data: Partial<Repo>) => {
      repo = { ...repo, ...data };
      for (const listener of listeners) listener(repo);
      return repo;
    }),
    on: (_event: string, listener: (value: Repo) => void) => listeners.add(listener),
    removeListener: (_event: string, listener: (value: Repo) => void) => listeners.delete(listener),
  };
  const branches = { get: vi.fn(async () => branch), on: vi.fn(), removeListener: vi.fn() };
  const boardListeners = new Set<(value: Board) => void>();
  let boardObj =
    options?.board !== undefined
      ? options.board
      : ({
          board_id: 'board-1',
          name: 'Test Board',
          primary_owner_user_id: 'board-owner-1',
        } as Board);
  const boards = {
    get: vi.fn(async (id: string) => {
      if (!boardObj || (boardObj.board_id && boardObj.board_id !== id)) {
        throw new Error('Board not found');
      }
      return boardObj;
    }),
    patch: vi.fn(async (_id: string, data: Partial<Board>) => {
      if (boardObj) {
        boardObj = { ...boardObj, ...data };
        for (const listener of boardListeners) listener(boardObj);
      }
      return boardObj;
    }),
    emit: (event: string, value: Board) => {
      if (event === 'patched') {
        for (const listener of boardListeners) listener(value);
      }
    },
    on: vi.fn((_event: string, listener: (value: Board) => void) => boardListeners.add(listener)),
    removeListener: vi.fn((_event: string, listener: (value: Board) => void) =>
      boardListeners.delete(listener)
    ),
  };
  const boardAccessFind = vi.fn(async () => ({
    capabilities: ['board.view', 'board.policy.manage'],
    fs_access: 'none' as const,
    source: 'group' as const,
    group_ids: [],
    is_primary_owner: false,
    ...options?.boardAccess,
  }));
  const branchAccessFind = vi.fn(
    async (): Promise<EffectiveBranchAccess> => ({
      can: 'view',
      fs_access: 'none',
      is_owner: false,
      source: 'others',
      ...options?.branchAccess,
    })
  );
  const services: Record<string, unknown> = {
    repos,
    branches,
    boards,
    'boards/:id/effective-access': { find: boardAccessFind },
    'branches/:id/effective-access': { find: branchAccessFind },
  };
  const client = {
    service: (path: string) => services[path],
  } as unknown as AgorClient;
  return {
    branch,
    repos,
    client,
    access: branchAccessFind,
    boardAccess: boardAccessFind,
    boards,
    branches,
  };
}

describe('Issue #3241: Board administrator branch archive authorization', () => {
  it('1. Branch owner can archive', async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: true, can: 'all', fs_access: 'write' },
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'user-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'archive',
      filesystemAction: 'preserved',
    });
  });

  it('2. Branch manager can archive', async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'all', fs_access: 'write' },
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'manager-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'archive',
      filesystemAction: 'preserved',
    });
  });

  it("3. Board administrator can archive another user's branch", async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view' },
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
    });
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'board-admin-1' })}
        branch={branch}
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
    expect(screen.getByRole('radio', { name: /Archive \(recommended\)/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /^Delete permanently/ })).toBeDisabled();
    expect(
      screen.getAllByText('Branch Manager authority is required to delete.').length
    ).toBeGreaterThan(0);
  });

  it('4. Workspace administrator can archive when backend role semantics permit it', async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view' },
      boardAccess: { capabilities: ['board.view'] }, // no explicit board policy manage
    });
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'admin', user_id: 'workspace-admin-1' })}
        branch={branch}
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
  });

  it('5. Board administrator can submit the archive operation with the expected payload', async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view' },
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'board-admin-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'archive',
      filesystemAction: 'preserved',
    });
  });

  it("5a. Board administrator with fs_access: 'none' can archive with filesystemAction: 'cleaned'", async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view', fs_access: 'none' },
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
      cleanupEnabled: true,
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'board-admin-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
    const cleanRadio = screen.getByRole('radio', { name: /^Clean —/ });
    expect(cleanRadio).toBeEnabled();
    expect(
      screen.queryByText('Writable workspace access is required to clean or delete files.')
    ).not.toBeInTheDocument();
    fireEvent.click(cleanRadio);
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'archive',
      filesystemAction: 'cleaned',
    });
  });

  it("5b. Board administrator with fs_access: 'none' can archive with filesystemAction: 'deleted'", async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view', fs_access: 'none' },
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'board-admin-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
    const deleteFilesystemRadio = screen.getByRole('radio', { name: /^Delete completely/ });
    expect(deleteFilesystemRadio).toBeEnabled();
    expect(
      screen.queryByText('Writable workspace access is required to clean or delete files.')
    ).not.toBeInTheDocument();
    fireEvent.click(deleteFilesystemRadio);
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'archive',
      filesystemAction: 'deleted',
    });
  });

  it("6. Regular member cannot archive another user's branch", async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view' },
      boardAccess: { capabilities: ['board.view', 'board.edit'] }, // member has edit but not manage
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'member-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(
      screen.getAllByText('Branch Manager authority is required to archive or delete.').length
    ).toBeGreaterThan(0);
  });

  it('7. Administrator of another board cannot archive', async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view' },
      boardAccess: { capabilities: ['board.view'] }, // not admin on this board
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'other-board-admin' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("8. Board administrator cannot permanently delete another user's branch merely because they can archive", async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view' },
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'board-admin-1' })}
        branch={branch}
        open
        initialMetadataAction="delete"
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled()
    );
    expect(screen.getByRole('radio', { name: /^Delete permanently/ })).toBeDisabled();
    expect(
      screen.getAllByText('Branch Manager authority is required to delete.').length
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('9. Permission-loading failures do not accidentally grant authorization', async () => {
    const { client, branch, access } = boardFixture({
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
    });
    access.mockRejectedValue(new Error('Permission service failure'));
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'board-admin-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await screen.findAllByText('Branch permissions could not be loaded.');
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('10. A branch without an associated board does not receive board-admin authorization', async () => {
    const { client, branch } = boardFixture({
      branchOverrides: { board_id: undefined },
      branchAccess: { is_owner: false, can: 'view' },
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'admin', user_id: 'admin-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled()
    );
    expect(
      screen.getAllByText('Branch Manager authority is required to archive or delete.').length
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('11. Switch from archive to delete and verify permissions are recalculated', async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: true, can: 'all', fs_access: 'write' },
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'user-1' })}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('radio', { name: /^Delete permanently/ }));
    expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeEnabled();
    expect(
      screen.getByText(/All 0 session\(s\), messages, and history will be permanently deleted/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'delete',
      filesystemAction: 'deleted',
    });
  });

  it('12. Switch from delete to archive and verify permissions are recalculated', async () => {
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: false, can: 'view' },
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
    });
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser({ role: 'member', user_id: 'board-admin-1' })}
        branch={branch}
        open
        initialMetadataAction="delete"
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled()
    );
    expect(
      screen.getByText('Branch Manager authority is required to delete.', {
        selector: '.ant-alert-title',
      })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Archive \(recommended\)/ }));
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled();
    expect(
      screen.queryByText('Branch Manager authority is required to delete.', {
        selector: '.ant-alert-title',
      })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Delete permanently/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'archive',
      filesystemAction: 'preserved',
    });
  });

  it('13. Verify loading states do not allow premature submission', async () => {
    let resolveBranch: (value: unknown) => void = () => {};
    const delayedBranchPromise = new Promise((resolve) => {
      resolveBranch = resolve;
    });
    const { client, branch } = boardFixture({
      branchAccess: { is_owner: true, can: 'all', fs_access: 'write' },
    });
    (client.service('branches') as { get: ReturnType<typeof vi.fn> }).get.mockImplementation(
      () => delayedBranchPromise
    );
    const confirm = vi.fn();
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={makeUser()}
        branch={branch}
        open
        onConfirm={confirm}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => {
      resolveBranch(branch);
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled()
    );
  });

  it('14. Emitting a board update event for Board A refreshes eligibility when the branch is on Board A', async () => {
    const { client, branch, boards, boardAccess } = boardFixture({
      board: {
        board_id: 'board-1',
        name: 'Test Board A',
        primary_owner_user_id: 'board-owner-1',
      } as Board,
      boardAccess: { capabilities: ['board.view', 'board.policy.manage'] },
    });
    const user = makeUser({ user_id: 'manager-user', role: 'member' });
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={user}
        branch={branch}
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(await screen.findByRole('button', { name: 'Archive Branch' })).toBeEnabled();

    // Revoke board management rights on backend
    boardAccess.mockResolvedValueOnce({
      capabilities: ['board.view'],
      fs_access: 'none',
      source: 'group',
      group_ids: [],
      is_primary_owner: false,
    });

    // Emit boards:patched event for board-1
    await act(async () => {
      boards.emit('patched', {
        board_id: 'board-1',
        name: 'Test Board A Updated',
        primary_owner_user_id: 'board-owner-1',
      } as Board);
    });

    // Eligibility refreshes and archive button becomes disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled();
    });
  });

  it('15. Emitting a board update event for Board B does not trigger refresh when branch is on Board A', async () => {
    const { client, branch, boards } = boardFixture({
      board: {
        board_id: 'board-1',
        name: 'Test Board A',
        primary_owner_user_id: 'board-owner-1',
      } as Board,
    });
    const user = makeUser({ user_id: 'manager-user', role: 'member' });
    render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={user}
        branch={branch}
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(await screen.findByRole('button', { name: 'Archive Branch' })).toBeEnabled();

    const initialBoardGetCalls = boards.get.mock.calls.length;

    // Emit boards:patched event for unrelated board-2
    await act(async () => {
      boards.emit('patched', {
        board_id: 'board-2',
        name: 'Unrelated Board B',
        primary_owner_user_id: 'someone-else',
      } as Board);
    });

    // boards.get was not called again
    expect(boards.get.mock.calls.length).toBe(initialBoardGetCalls);
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeEnabled();
  });

  it('16. The boards event listener is cleanly removed when the modal unmounts', async () => {
    const { client, branch, boards } = boardFixture();
    const user = makeUser({ user_id: 'manager-user', role: 'member' });
    const { unmount } = render(
      <ArchiveDeleteBranchModal
        client={client}
        currentUser={user}
        branch={branch}
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    await screen.findByRole('button', { name: 'Archive Branch' });

    expect(boards.on).toHaveBeenCalledWith('patched', expect.any(Function));
    const registeredListener = boards.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'patched'
    )?.[1];
    expect(registeredListener).toBeDefined();

    unmount();

    expect(boards.removeListener).toHaveBeenCalledWith('patched', registeredListener);
  });
});
