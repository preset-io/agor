import type { Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
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

    render(<ReposTable repoById={repoById} isAdmin={false} />);

    fireEvent.change(screen.getByPlaceholderText(/Search name, slug, URL/i), {
      target: { value: 'preset-docs' },
    });

    expect(screen.queryByText('Agor')).not.toBeInTheDocument();
    expect(screen.getByText('Docs Site')).toBeInTheDocument();
    expect(screen.getByText('preset-docs').tagName.toLowerCase()).toBe('mark');
  });

  it('keeps repository discovery read-only for members', () => {
    const repo = makeRepo({ name: 'Shared Repository' });
    render(
      <ReposTable
        repoById={new Map([[repo.repo_id, repo]])}
        isAdmin={false}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByText('Shared Repository')).toBeInTheDocument();
    expect(screen.getByText(/managed by workspace administrators/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Repository/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Edit Shared Repository/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Delete Shared Repository/i })
    ).not.toBeInTheDocument();
  });

  it('shows repository mutation controls to admins', () => {
    const repo = makeRepo({ name: 'Managed Repository' });
    render(<ReposTable repoById={new Map([[repo.repo_id, repo]])} isAdmin />);

    expect(screen.getByRole('button', { name: /New Repository/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit Managed Repository/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Managed Repository/i })).toBeInTheDocument();
  });
});
