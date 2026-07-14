import type { Repo } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEnsureFrameworkRepo } from './useEnsureFrameworkRepo';
import { FRAMEWORK_REPO_SLUG, FRAMEWORK_REPO_URL } from './useFrameworkRepo';

describe('useEnsureFrameworkRepo', () => {
  it('clones the framework repo when enabled and it is not registered yet', async () => {
    const onCreateRepo = vi.fn(async () => undefined);
    renderHook(() => useEnsureFrameworkRepo([], onCreateRepo, { enabled: true }));

    await waitFor(() => expect(onCreateRepo).toHaveBeenCalledTimes(1));
    expect(onCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({ url: FRAMEWORK_REPO_URL, slug: FRAMEWORK_REPO_SLUG })
    );
  });

  it('does not clone while disabled (wizard not open yet)', async () => {
    const onCreateRepo = vi.fn(async () => undefined);
    renderHook(() => useEnsureFrameworkRepo([], onCreateRepo, { enabled: false }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCreateRepo).not.toHaveBeenCalled();
  });

  it('does not clone when the framework repo is already registered', async () => {
    const onCreateRepo = vi.fn(async () => undefined);
    const repos = [{ repo_id: 'r1', slug: FRAMEWORK_REPO_SLUG } as Repo];

    const { result } = renderHook(() =>
      useEnsureFrameworkRepo(repos, onCreateRepo, { enabled: true })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCreateRepo).not.toHaveBeenCalled();
    expect(result.current.frameworkRepo?.slug).toBe(FRAMEWORK_REPO_SLUG);
  });
});
