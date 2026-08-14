/**
 * Regression test for BranchesTable source-branch preservation in the
 * Settings → Branches → Create Branch modal.
 *
 * Same root cause as NewBranchModal / BranchTab — every `repos.patched`
 * (or `boards.patched`) WebSocket event hands the table new array
 * references for `repos` / `boards`, which re-fired the form-init
 * `useEffect`, and `setFieldsValue({ sourceBranch })` silently overwrote
 * whatever the user typed back to the repo's `default_branch`.
 *
 * The fix is the same useRef guard so init runs exactly once per
 * `createModalOpen=true` session.
 */

import type { AgorClient, Board, Branch, Repo } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BranchesTable } from './BranchesTable';

/** BranchesTable uses useAppNavigation → useNavigate under the hood,
 *  so the test wraps in a Router. It needs no data-context provider
 *  (table reads navigation maps from its props). */
function renderWithProviders(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'org/repo-1',
    name: 'repo-1',
    default_branch: 'main',
    repo_type: 'remote',
    remote_url: 'https://github.com/org/repo-1.git',
    local_path: '/tmp/repo-1',
    ...overrides,
  } as unknown as Repo;
}

describe('BranchesTable — source-branch preservation', { timeout: 10_000 }, () => {
  it('preserves user-typed sourceBranch across `repoById` / `boardById` Map reference churn', () => {
    const repo = makeRepo({ default_branch: 'main' });
    const repoById = new Map([[repo.repo_id, repo]]);
    const boardById = new Map<string, Board>();
    const branchById = new Map<string, Branch>();
    const sessionsByBranch = new Map<string, never[]>();

    const { rerender } = renderWithProviders(
      <BranchesTable
        client={null}
        branchById={branchById}
        repoById={repoById}
        boardById={boardById}
        sessionsByBranch={sessionsByBranch as Map<string, never[]>}
      />
    );

    // Open the create modal
    fireEvent.click(screen.getByRole('button', { name: /Create Branch/i }));

    // The init effect populates sourceBranch from the repo's default_branch
    const branchInput = screen.getByLabelText(/Source Branch/i) as HTMLInputElement;
    expect(branchInput.value).toBe('main');

    // User types their pinned branch
    fireEvent.change(branchInput, { target: { value: 'release/2024-q1' } });
    expect(branchInput.value).toBe('release/2024-q1');

    // Simulate a `repos.patched` WebSocket event by handing the table NEW
    // Map references for repoById and boardById. Same data, different refs.
    rerender(
      <MemoryRouter>
        <BranchesTable
          client={null}
          branchById={branchById}
          repoById={new Map([[repo.repo_id, repo]])}
          boardById={new Map<string, Board>()}
          sessionsByBranch={sessionsByBranch as Map<string, never[]>}
        />
      </MemoryRouter>
    );

    expect((screen.getByLabelText(/Source Branch/i) as HTMLInputElement).value).toBe(
      'release/2024-q1'
    );
  });

  it('surfaces a retryable filesystem deletion failure', () => {
    const repo = makeRepo();
    const branch = {
      branch_id: 'branch-delete-failed',
      repo_id: repo.repo_id,
      name: 'failed-delete',
      ref: 'failed-delete',
      path: '/tmp/failed-delete',
      archived: false,
      filesystem_status: 'delete_failed',
      error_message: 'Privileged filesystem deletion is unavailable or was denied.',
      created_at: '2026-08-14T00:00:00.000Z',
    } as unknown as Branch;

    renderWithProviders(
      <BranchesTable
        client={null}
        branchById={new Map([[branch.branch_id, branch]])}
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map<string, Board>()}
        sessionsByBranch={new Map()}
      />
    );

    expect(screen.getByText('delete failed')).toBeInTheDocument();
  });

  it('evicts an archived row when metadata is removed by another client', async () => {
    const repo = makeRepo();
    const archivedBranch = {
      branch_id: 'branch-removed-remotely',
      repo_id: repo.repo_id,
      name: 'removed-remotely',
      ref: 'removed-remotely',
      path: '/tmp/removed-remotely',
      archived: true,
      filesystem_status: 'deleted',
      created_at: '2026-08-14T00:00:00.000Z',
    } as unknown as Branch;
    let removedListener: ((branch: Branch) => void) | undefined;
    const branchesService = {
      findAll: vi.fn().mockResolvedValue([archivedBranch]),
      on: vi.fn((event: string, listener: (branch: Branch) => void) => {
        if (event === 'removed') removedListener = listener;
      }),
      removeListener: vi.fn(),
    };
    const client = {
      service: vi.fn(() => branchesService),
    } as unknown as AgorClient;

    renderWithProviders(
      <BranchesTable
        client={client}
        branchById={new Map()}
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map<string, Board>()}
        sessionsByBranch={new Map()}
      />
    );

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByTitle('Archived'));
    expect(await screen.findByText('removed-remotely')).toBeInTheDocument();

    act(() => removedListener?.(archivedBranch));

    await waitFor(() => expect(screen.queryByText('removed-remotely')).not.toBeInTheDocument());
  });
});
