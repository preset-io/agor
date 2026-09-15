import type { Repo } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReposTable } from './ReposTable';

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
    const rendered = render(view(1));
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

describe('ReposTable cleanup configuration authority', () => {
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
    const rendered = render(view(repo));
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
    expect(onUpdate.mock.calls[0][1]).toEqual({ slug: repo.slug, default_branch: 'develop' });
  });

  it('saves a deliberately changed administrator policy even when collapsed', async () => {
    const repo = makeRepo({
      cleanup_policy: { enabled: true, command: './cleanup.sh', allow_branch_protection: true },
    });
    const onUpdate = vi.fn();
    render(
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
});
