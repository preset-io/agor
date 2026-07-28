/**
 * Regression tests for BranchTab source-branch preservation.
 *
 * Same root cause as NewBranchModal.test.tsx — every `repos.patched`
 * WebSocket event gave the parent component a new `repoById` Map
 * reference, re-firing the form-init `useEffect`, and `setFieldsValue`
 * silently overwrote the user's typed `sourceBranch` with the repo's
 * `default_branch`. Different surface (the BranchTab inside the unified
 * CreateDialog) — same fix (useRef gate so init runs once per mount).
 */

import type { Board, Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BranchTab, type BranchTabConfig } from './BranchTab';

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

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    board_id: 'board-1',
    name: 'Board One',
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    created_by: 'user-1',
    url: '',
    archived: false,
    objects: {},
    ...overrides,
  } as unknown as Board;
}

describe('BranchTab — source-branch preservation', () => {
  it('preserves user-typed sourceBranch across `repoById` Map reference churn (WebSocket patches)', () => {
    const formRef: React.MutableRefObject<(() => Promise<BranchTabConfig | null>) | null> = {
      current: null,
    };
    const repo = makeRepo({ default_branch: 'main' });

    const { rerender } = render(
      <BranchTab
        repoById={new Map([[repo.repo_id, repo]])}
        onValidityChange={vi.fn()}
        formRef={formRef}
      />
    );

    const branchInput = screen.getByLabelText(/Source Branch/i) as HTMLInputElement;
    expect(branchInput.value).toBe('main');

    fireEvent.change(branchInput, { target: { value: 'release/2024-q1' } });
    expect(branchInput.value).toBe('release/2024-q1');

    // New Map reference, same data — pre-fix this would reset the field.
    rerender(
      <BranchTab
        repoById={new Map([[repo.repo_id, repo]])}
        onValidityChange={vi.fn()}
        formRef={formRef}
      />
    );

    expect((screen.getByLabelText(/Source Branch/i) as HTMLInputElement).value).toBe(
      'release/2024-q1'
    );
  });
});

describe('BranchTab — branch storage policy', () => {
  async function renderBranchTab(
    branchStorageConfig?: React.ComponentProps<typeof BranchTab>['branchStorageConfig']
  ) {
    const formRef: React.MutableRefObject<(() => Promise<BranchTabConfig | null>) | null> = {
      current: null,
    };
    const repo = makeRepo({ default_branch: 'main' });
    const board = makeBoard();

    render(
      <BranchTab
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map([[board.board_id, board]])}
        currentBoardId={board.board_id}
        onValidityChange={vi.fn()}
        formRef={formRef}
        branchStorageConfig={branchStorageConfig}
      />
    );

    await waitFor(() => expect(screen.getByLabelText(/Source Branch/i)).toHaveValue('main'));
    fireEvent.change(screen.getByLabelText(/Branch Name/i), {
      target: { value: 'feat-storage' },
    });

    return { formRef };
  }

  it('defaults to clone and disables worktree when the server only allows clone', async () => {
    const { formRef } = await renderBranchTab({
      defaultMode: 'clone',
      allowedModes: ['clone'],
    });

    expect(screen.getByRole('radio', { name: /Clone \(default\)/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Worktree/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Worktree/i }));
    expect(screen.getByRole('radio', { name: /Clone \(default\)/i })).toBeChecked();
    const result = await formRef.current?.();
    expect(result).toBeTruthy();
    expect(result!.storage_mode).toBe('clone');
    expect(result!.clone_depth).toBe(100);
  });

  it('allows both modes and respects a server default of clone', async () => {
    const { formRef } = await renderBranchTab({
      defaultMode: 'clone',
      allowedModes: ['worktree', 'clone'],
    });

    expect(screen.getByRole('radio', { name: /Clone \(default\)/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Worktree/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /Worktree/i }));
    expect(screen.getByRole('radio', { name: /Worktree/i })).toBeChecked();
    const result = await formRef.current?.();
    expect(result).toBeTruthy();
    expect(result!.storage_mode).toBe('worktree');
  });

  it('keeps existing/default behavior when branch storage config is absent', async () => {
    const { formRef } = await renderBranchTab();

    expect(screen.getByRole('radio', { name: /Worktree \(default\)/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Clone/i })).not.toBeDisabled();
    const result = await formRef.current?.();
    expect(result).toBeTruthy();
    expect(result!.storage_mode).toBe('worktree');
  });
});

describe('BranchTab — repository clone readiness', () => {
  it('does not select or submit a failed repository', async () => {
    const formRef: React.MutableRefObject<(() => Promise<BranchTabConfig | null>) | null> = {
      current: null,
    };
    const repo = makeRepo({
      clone_status: 'failed',
      clone_error: {
        exit_code: 124,
        category: 'timeout',
        message: 'Clone timed out after 30 minutes.',
      },
    });
    const board = makeBoard();
    const onValidityChange = vi.fn();

    render(
      <BranchTab
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map([[board.board_id, board]])}
        currentBoardId={board.board_id}
        onValidityChange={onValidityChange}
        formRef={formRef}
      />
    );

    expect(screen.getByText('No repositories are ready')).toBeInTheDocument();
    expect(await formRef.current?.()).toBeNull();
    expect(onValidityChange).not.toHaveBeenCalledWith(true);
  });

  it('skips a failed last-used repository and initializes the first ready repository', async () => {
    const formRef: React.MutableRefObject<(() => Promise<BranchTabConfig | null>) | null> = {
      current: null,
    };
    const failed = makeRepo({
      repo_id: 'repo-failed',
      name: 'failed',
      clone_status: 'failed',
    });
    const ready = makeRepo({
      repo_id: 'repo-ready',
      name: 'ready',
      default_branch: 'develop',
      clone_status: 'ready',
    });
    localStorage.setItem('agor-last-repo-id', failed.repo_id);

    render(
      <BranchTab
        repoById={
          new Map([
            [failed.repo_id, failed],
            [ready.repo_id, ready],
          ])
        }
        onValidityChange={vi.fn()}
        formRef={formRef}
      />
    );

    await waitFor(() => expect(screen.getByLabelText(/Source Branch/i)).toHaveValue('develop'));
  });

  it('invalidates an open form if the selected clone later fails', async () => {
    const formRef: React.MutableRefObject<(() => Promise<BranchTabConfig | null>) | null> = {
      current: null,
    };
    const board = makeBoard();
    const ready = makeRepo({ clone_status: 'ready' });
    const onValidityChange = vi.fn();
    const { rerender } = render(
      <BranchTab
        repoById={new Map([[ready.repo_id, ready]])}
        boardById={new Map([[board.board_id, board]])}
        currentBoardId={board.board_id}
        onValidityChange={onValidityChange}
        formRef={formRef}
      />
    );

    fireEvent.change(screen.getByLabelText(/Branch Name/i), {
      target: { value: 'new-branch' },
    });
    await waitFor(() => expect(onValidityChange).toHaveBeenCalledWith(true));

    const failed = makeRepo({
      clone_status: 'failed',
      clone_error: {
        exit_code: 124,
        category: 'timeout',
        message: 'Clone timed out after 30 minutes.',
      },
    });
    rerender(
      <BranchTab
        repoById={new Map([[failed.repo_id, failed]])}
        boardById={new Map([[board.board_id, board]])}
        currentBoardId={board.board_id}
        onValidityChange={onValidityChange}
        formRef={formRef}
      />
    );

    await waitFor(() => {
      expect(onValidityChange).toHaveBeenLastCalledWith(false);
    });
    expect(screen.getByText('Repository clone failed')).toBeInTheDocument();
    expect(await formRef.current?.()).toBeNull();
  });
});
