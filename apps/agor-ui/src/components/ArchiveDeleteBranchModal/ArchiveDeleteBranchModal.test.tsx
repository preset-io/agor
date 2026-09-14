import type { AgorClient, EffectiveBranchAccess, Repo } from '@agor-live/client';
import { DEFAULT_REPO_CLEANUP_POLICY } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { makeBranch, makeRepo, makeUser } from '../BranchModal/testUtils';
import { ArchiveDeleteBranchModal } from './ArchiveDeleteBranchModal';

function fixture(enabled = false) {
  const branch = makeBranch();
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
  const services = { repos, branches, 'branches/:id/effective-access': access };
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
  expect(screen.getByRole('radio', { name: /Leave untouched/ })).toBeChecked();
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
  expect(screen.getByRole('radio', { name: /Leave untouched/ })).toBeChecked();
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
  fireEvent.click(screen.getByRole('radio', { name: /Leave untouched/ }));
  await act(async () => {
    await repos.patch('unused', {
      cleanup_policy: { ...DEFAULT_REPO_CLEANUP_POLICY, enabled: true, command: 'git clean -fdX' },
    });
  });
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /Clean — git clean -fdX/ })).toBeEnabled()
  );
  expect(screen.getByRole('radio', { name: /Leave untouched/ })).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: /Clean —/ }));
  branch.cleanup_protected = true;
  await act(async () => {
    await repos.patch('unused', {});
  });
  await waitFor(() => expect(screen.getByRole('radio', { name: /Clean —/ })).toBeDisabled());
  expect(screen.getByRole('radio', { name: /Leave untouched/ })).toBeChecked();
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
  expect(screen.getByRole('radio', { name: /Leave untouched/ })).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Open repository settings' })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
  expect(confirm).toHaveBeenLastCalledWith({
    metadataAction: 'delete',
    filesystemAction: 'deleted',
  });
  fireEvent.click(screen.getByRole('radio', { name: /Archive \(recommended\)/ }));
  expect(screen.getByRole('radio', { name: /Leave untouched/ })).toBeChecked();
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
  await screen.findByText('Deletion failed');
  expect(screen.getByRole('radio', { name: /Archive \(recommended\)/ })).toBeDisabled();
  expect(screen.getByRole('radio', { name: /Delete completely/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
  expect(confirm).toHaveBeenCalledWith({ metadataAction: 'delete', filesystemAction: 'deleted' });
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
  await screen.findByText('Branch permissions could not be loaded.');
  expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled();
});
