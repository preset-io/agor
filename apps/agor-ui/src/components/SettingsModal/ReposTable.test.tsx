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
