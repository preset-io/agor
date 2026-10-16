import type { Repo } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReposTable } from './ReposTable';
import { renderWithSettingsShell } from './settingsDrillTestUtils';

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    repo_id: overrides.repo_id ?? 'repo-1',
    name: overrides.name ?? 'Repository',
    slug: overrides.slug ?? 'org/repository',
    default_branch: overrides.default_branch ?? 'main',
    repo_type: overrides.repo_type ?? 'remote',
    remote_url: overrides.remote_url ?? 'https://github.com/org/repository.git',
    local_path: overrides.local_path,
    ...overrides,
  } as Repo;
}

describe('ReposTable search', () => {
  it('filters repositories by URL/path fields and highlights visible matches', () => {
    const repoById = new Map<string, Repo>([
      [
        'repo-1',
        makeRepo({
          repo_id: 'repo-1',
          name: 'Agor',
          slug: 'preset-io/agor',
          remote_url: 'https://github.com/preset-io/agor.git',
        }),
      ],
      [
        'repo-2',
        makeRepo({
          repo_id: 'repo-2',
          name: 'Docs Site',
          slug: 'preset-io/docs',
          repo_type: 'local',
          remote_url: undefined,
          local_path: '/workspace/preset-docs',
        }),
      ],
    ]);

    render(
      <ReposTable
        repoById={repoById}
        identityKey="admin-a:admin"
        operationScope={['admin-a:admin', 1]}
      />
    );

    fireEvent.change(screen.getByPlaceholderText(/Search name, slug, URL/i), {
      target: { value: 'preset-docs' },
    });

    expect(screen.queryByText('Agor')).not.toBeInTheDocument();
    expect(screen.getByText('Docs Site')).toBeInTheDocument();
    expect(screen.getByText('preset-docs').tagName.toLowerCase()).toBe('mark');
  });
});

describe('ReposTable authority fencing', () => {
  it('keeps the clone form and input after a rejected request', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('Request rejected');
    });
    renderWithSettingsShell(
      <ReposTable
        repoById={new Map()}
        identityKey="admin-a:admin"
        operationScope={['admin-a:admin', 1]}
        onCreate={onCreate}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /new repository/i }));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/apache/superset.git'), {
      target: { value: 'https://github.com/preset-io/agor.git' },
    });
    fireEvent.change(screen.getByPlaceholderText('apache/superset'), {
      target: { value: 'preset-io/agor' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^clone$/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(screen.getByText('Clone Repository')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('apache/superset')).toHaveValue('preset-io/agor');
  });

  it('preserves a same-user reconnect draft but does not close from the obsolete create', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const onCreate = vi.fn(() => pending);
    const view = (generation: number) => (
      <ReposTable
        repoById={new Map()}
        identityKey="admin-a:admin"
        operationScope={['admin-a:admin', generation]}
        onCreate={onCreate}
      />
    );
    const rendered = renderWithSettingsShell(view(1));
    fireEvent.click(screen.getByRole('button', { name: /new repository/i }));
    const url = screen.getByPlaceholderText('https://github.com/apache/superset.git');
    fireEvent.change(url, { target: { value: 'https://github.com/preset-io/agor.git' } });
    fireEvent.change(screen.getByPlaceholderText('apache/superset'), {
      target: { value: 'preset-io/agor' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^clone$/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());

    rendered.rerender(view(2));
    await act(async () => {
      resolve();
      await pending;
    });

    expect(screen.getByText('Clone Repository')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://github.com/apache/superset.git')).toHaveValue(
      'https://github.com/preset-io/agor.git'
    );
  });
});

// Full drill-in edit flows (table, form, shell footer): 6-8s alone, so the
// 15s default trips under full-suite load.
describe('ReposTable cleanup configuration authority', { timeout: 30_000 }, () => {
  it.each([false, true])('omits unchanged policy from metadata saves (admin=%s)', async (admin) => {
    const repo = makeRepo({
      cleanup_policy: { enabled: true, command: './cleanup.sh', allow_branch_protection: true },
    });
    const onUpdate = vi.fn();
    const view = (row: Repo) => (
      <ReposTable
        repoById={new Map([[row.repo_id, row]])}
        identityKey={admin ? 'admin:admin' : 'member:member'}
        operationScope={[admin ? 'admin:admin' : 'member:member', 1]}
        canConfigureCleanup={admin}
        onUpdate={onUpdate}
      />
    );
    const rendered = renderWithSettingsShell(view(repo));
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    if (!admin)
      expect(screen.queryByRole('button', { name: /Branch cleanup/ })).not.toBeInTheDocument();
    // A concurrent policy update must not be replaced by this metadata-only draft.
    rendered.rerender(
      view({
        ...repo,
        cleanup_policy: { ...repo.cleanup_policy!, command: './new-policy.sh' },
      })
    );
    fireEvent.change(screen.getByLabelText('Default Branch'), { target: { value: 'develop' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0][1]).toEqual({ default_branch: 'develop' });
  });

  it('saves a deliberately changed administrator policy even when collapsed', async () => {
    const repo = makeRepo({
      cleanup_policy: { enabled: true, command: './cleanup.sh', allow_branch_protection: true },
    });
    const onUpdate = vi.fn();
    renderWithSettingsShell(
      <ReposTable
        repoById={new Map([[repo.repo_id, repo]])}
        identityKey="admin:admin"
        operationScope={['admin:admin', 1]}
        canConfigureCleanup
        onUpdate={onUpdate}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Branch cleanup/ }));
    fireEvent.change(screen.getByLabelText('Cleanup command'), {
      target: { value: './changed.sh' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Branch cleanup/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0][1].cleanup_policy).toEqual({
      ...repo.cleanup_policy,
      command: './changed.sh',
    });
  });

  it('merges a changed policy key over a concurrent policy edit instead of reverting it', async () => {
    const repo = makeRepo({
      cleanup_policy: { enabled: true, command: './cleanup.sh', allow_branch_protection: false },
    });
    const onUpdate = vi.fn();
    const view = (row: Repo) => (
      <ReposTable
        repoById={new Map([[row.repo_id, row]])}
        identityKey="admin:admin"
        operationScope={['admin:admin', 1]}
        canConfigureCleanup
        onUpdate={onUpdate}
      />
    );
    const rendered = renderWithSettingsShell(view(repo));
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Branch cleanup/ }));
    fireEvent.change(screen.getByLabelText('Cleanup command'), {
      target: { value: './changed.sh' },
    });
    // Another administrator turns on branch protection meanwhile.
    rendered.rerender(
      view({ ...repo, cleanup_policy: { ...repo.cleanup_policy!, allow_branch_protection: true } })
    );
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0][1]).toEqual({
      cleanup_policy: { enabled: true, command: './changed.sh', allow_branch_protection: true },
    });
  });
});

describe('repository setup status', () => {
  it.each([
    ['cloning', 'Cloning'],
    ['ready', 'Ready'],
    ['failed', 'Failed'],
    [undefined, 'Ready'],
  ] as const)('renders persisted %s status explicitly', (clone_status, label) => {
    const repo = makeRepo({ clone_status });
    renderWithSettingsShell(
      <ReposTable
        repoById={new Map([[repo.repo_id, repo]])}
        identityKey="member:member"
        operationScope={['member:member', 1]}
      />
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows failed diagnostics on demand and retries the same source without deletion', async () => {
    const repo = makeRepo({
      clone_status: 'failed',
      clone_generation: 2,
      clone_error: {
        category: 'network',
        exit_code: 1,
        message: 'credential-redacted synthetic diagnostic',
      },
    });
    const onCreate = vi.fn(async () => {});
    const onDelete = vi.fn();
    renderWithSettingsShell(
      <ReposTable
        repoById={new Map([[repo.repo_id, repo]])}
        identityKey="member:member"
        operationScope={['member:member', 1]}
        onCreate={onCreate}
        onDelete={onDelete}
      />
    );
    // The list flags the row; the edit drill-in carries the detail and retry.
    expect(screen.getByText('Failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByText('Repository setup failed')).toBeVisible();
    expect(screen.queryByText('credential-redacted synthetic diagnostic')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Setup diagnostics'));
    expect(await screen.findByText('credential-redacted synthetic diagnostic')).toBeVisible();
    fireEvent.click(screen.getByText('Retry setup'));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        { url: repo.remote_url, slug: repo.slug, default_branch: 'main' },
        expect.any(Function)
      )
    );
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('ReposTable live updates', () => {
  it('keeps a typed draft over a remote slug change and saves only the default branch', async () => {
    const repo = makeRepo({ slug: 'org/repository', default_branch: 'main' });
    const onUpdate = vi.fn();
    const view = (row: Repo) => (
      <ReposTable
        repoById={new Map([[row.repo_id, row]])}
        identityKey="admin:admin"
        operationScope={['admin:admin', 1]}
        onUpdate={onUpdate}
      />
    );
    const rendered = renderWithSettingsShell(view(repo));
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText('Default Branch'), { target: { value: 'develop' } });

    rendered.rerender(view({ ...repo, slug: 'org/renamed', default_branch: 'trunk' }));
    // Neither the draft nor an untouched field follows the record while it is open.
    await waitFor(() => expect(screen.getByLabelText('Default Branch')).toHaveValue('develop'));
    expect(screen.getByLabelText('Repository Slug')).toHaveValue('org/repository');

    // The save leaves the remote slug change alone.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    expect(onUpdate.mock.calls[0][1]).toEqual({ default_branch: 'develop' });
  });

  it('leaves a seeded but unchanged edit without asking to discard', async () => {
    const repo = makeRepo({});
    renderWithSettingsShell(
      <ReposTable
        repoById={new Map([[repo.repo_id, repo]])}
        identityKey="admin:admin"
        operationScope={['admin:admin', 1]}
      />,
      'repos'
    );
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await waitFor(() => expect(screen.getByLabelText('Default Branch')).toHaveValue('main'));
    fireEvent.click(screen.getByText('Repositories'));
    await waitFor(() => expect(screen.queryByLabelText('Default Branch')).not.toBeInTheDocument());
    expect(document.querySelectorAll('.ant-modal-confirm')).toHaveLength(0);
  });
});
