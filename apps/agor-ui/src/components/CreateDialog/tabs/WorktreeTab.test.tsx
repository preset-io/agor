/**
 * Regression tests for WorktreeTab source-branch preservation.
 *
 * Same root cause as NewWorktreeModal.test.tsx — every `repos.patched`
 * WebSocket event gave the parent component a new `repoById` Map
 * reference, re-firing the form-init `useEffect`, and `setFieldsValue`
 * silently overwrote the user's typed `sourceBranch` with the repo's
 * `default_branch`. Different surface (the WorktreeTab inside the unified
 * CreateDialog) — same fix (useRef gate so init runs once per mount).
 */

import type { Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeTab, type WorktreeTabConfig } from './WorktreeTab';

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

describe('WorktreeTab — source-branch preservation', { timeout: 10_000 }, () => {
  it('preserves user-typed sourceBranch across `repoById` Map reference churn (WebSocket patches)', () => {
    const formRef: React.MutableRefObject<(() => Promise<WorktreeTabConfig | null>) | null> = {
      current: null,
    };
    const repo = makeRepo({ default_branch: 'main' });

    const { rerender } = render(
      <WorktreeTab
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
      <WorktreeTab
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
