/**
 * Regression test for WorktreesTable source-branch preservation in the
 * Settings → Worktrees → Create Worktree modal.
 *
 * Same root cause as NewWorktreeModal / WorktreeTab — every `repos.patched`
 * (or `boards.patched`) WebSocket event hands the table new array
 * references for `repos` / `boards`, which re-fired the form-init
 * `useEffect`, and `setFieldsValue({ sourceBranch })` silently overwrote
 * whatever the user typed back to the repo's `default_branch`.
 *
 * The fix is the same useRef guard so init runs exactly once per
 * `createModalOpen=true` session.
 */

import type { Board, Repo, Worktree } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorktreesTable } from './WorktreesTable';

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

describe('WorktreesTable — source-branch preservation', { timeout: 10_000 }, () => {
  it('preserves user-typed sourceBranch across `repoById` / `boardById` Map reference churn', () => {
    const repo = makeRepo({ default_branch: 'main' });
    const repoById = new Map([[repo.repo_id, repo]]);
    const boardById = new Map<string, Board>();
    const worktreeById = new Map<string, Worktree>();
    const sessionsByWorktree = new Map<string, never[]>();

    const { rerender } = render(
      <WorktreesTable
        client={null}
        worktreeById={worktreeById}
        repoById={repoById}
        boardById={boardById}
        sessionsByWorktree={sessionsByWorktree as Map<string, never[]>}
      />
    );

    // Open the create modal
    fireEvent.click(screen.getByRole('button', { name: /Create Worktree/i }));

    // The init effect populates sourceBranch from the repo's default_branch
    const branchInput = screen.getByLabelText(/Source Branch/i) as HTMLInputElement;
    expect(branchInput.value).toBe('main');

    // User types their pinned branch
    fireEvent.change(branchInput, { target: { value: 'release/2024-q1' } });
    expect(branchInput.value).toBe('release/2024-q1');

    // Simulate a `repos.patched` WebSocket event by handing the table NEW
    // Map references for repoById and boardById. Same data, different refs.
    rerender(
      <WorktreesTable
        client={null}
        worktreeById={worktreeById}
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map<string, Board>()}
        sessionsByWorktree={sessionsByWorktree as Map<string, never[]>}
      />
    );

    expect((screen.getByLabelText(/Source Branch/i) as HTMLInputElement).value).toBe(
      'release/2024-q1'
    );
  });
});
