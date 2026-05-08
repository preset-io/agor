/**
 * Regression tests for NewWorktreeModal source-branch preservation.
 *
 * Bug: every `repos.patched` WebSocket event gave the parent component a
 * new `repoById` Map reference, which re-fired the form-init `useEffect`
 * and `setFieldsValue({ sourceBranch })` silently overwrote whatever the
 * user typed back to the repo's `default_branch`. The user only noticed
 * after submitting that the worktree was created off `main` instead of
 * their chosen branch.
 *
 * The fix gates initialization with a `useRef` so it runs exactly once per
 * modal-open session. These tests pin that guardrail.
 */

import type { Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewWorktreeModal } from './NewWorktreeModal';

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

describe('NewWorktreeModal — source-branch preservation', { timeout: 10_000 }, () => {
  it('preserves user-typed sourceBranch across `repoById` Map reference churn (WebSocket patches)', async () => {
    const repo = makeRepo({ default_branch: 'main' });
    const { rerender } = render(
      <NewWorktreeModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        repoById={new Map([[repo.repo_id, repo]])}
      />
    );

    // The init effect should populate sourceBranch from repo.default_branch
    // on first render. Use the visible label to locate the field.
    const branchInput = screen.getByLabelText(/Source Branch/i) as HTMLInputElement;
    expect(branchInput.value).toBe('main');

    // User clears the field and types their preferred branch.
    fireEvent.change(branchInput, { target: { value: 'release/2024-q1' } });
    expect(branchInput.value).toBe('release/2024-q1');

    // Simulate a WebSocket `repos.patched` event by handing the modal a NEW
    // Map reference. The repo data hasn't changed; only the reference has.
    // Pre-fix, this re-fired the effect and reset sourceBranch back to
    // 'main'. With the useRef guard, the typed value must persist.
    rerender(
      <NewWorktreeModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        repoById={new Map([[repo.repo_id, repo]])}
      />
    );

    expect((screen.getByLabelText(/Source Branch/i) as HTMLInputElement).value).toBe(
      'release/2024-q1'
    );
  });

  it('re-initializes sourceBranch when the modal is closed and re-opened', async () => {
    // Closing the modal must clear the "initialized" flag so the next open
    // populates fresh defaults. Otherwise a user who typed a stale value,
    // closed, came back later — and the form would still have the stale
    // typed value with no way to know it didn't come from the new repo.
    const repo = makeRepo({ default_branch: 'main' });
    const { rerender } = render(
      <NewWorktreeModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        repoById={new Map([[repo.repo_id, repo]])}
      />
    );

    fireEvent.change(screen.getByLabelText(/Source Branch/i), {
      target: { value: 'some-typed-value' },
    });

    rerender(
      <NewWorktreeModal
        open={false}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        repoById={new Map([[repo.repo_id, repo]])}
      />
    );

    // Re-open with an updated default_branch — the form should pick it up.
    const repoUpdated = makeRepo({ default_branch: 'develop' });
    rerender(
      <NewWorktreeModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        repoById={new Map([[repoUpdated.repo_id, repoUpdated]])}
      />
    );

    expect((screen.getByLabelText(/Source Branch/i) as HTMLInputElement).value).toBe('develop');
  });
});
