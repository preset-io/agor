import type { Repo } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
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
  it('StrictMode prefetch runs once and failed HTTP setup exposes safe status', async () => {
    const onCreateRepo = vi.fn(async () => {
      throw { code: 403, message: 'secret' };
    });
    const { result } = renderHook(() => useEnsureFrameworkRepo([], onCreateRepo), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.error).toContain('check your access'));
    expect(result.current.isCloning).toBe(false);
    expect(result.current.frameworkRepo).toBeUndefined();
    expect(onCreateRepo).toHaveBeenCalledTimes(1);
  });

  it('cloning and failed placeholders are not usable repos and do not cause retry storms', async () => {
    const onCreateRepo = vi.fn();
    const repo = { repo_id: 'r1', slug: FRAMEWORK_REPO_SLUG, clone_status: 'cloning' } as Repo;
    const { result, rerender } = renderHook(
      ({ row }) => useEnsureFrameworkRepo([row], onCreateRepo),
      { initialProps: { row: repo } }
    );
    await waitFor(() => expect(result.current.isCloning).toBe(true));
    expect(result.current.frameworkRepo).toBeUndefined();
    rerender({ row: { ...repo, clone_status: 'failed' } });
    await waitFor(() =>
      expect(result.current.error).toBe(
        "The repository couldn't be prepared, but your existing work wasn't removed. Try again, or ask an administrator if it keeps happening."
      )
    );
    expect(result.current.frameworkRepo).toBeUndefined();
    expect(result.current.isCloning).toBe(false);
    expect(onCreateRepo).not.toHaveBeenCalled();
  });

  it('late failure after owner change cannot change the new owner status', async () => {
    let fail!: (error: unknown) => void;
    const onCreateRepo = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          fail = reject;
        })
      )
      .mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ ownerKey }) => useEnsureFrameworkRepo([], onCreateRepo, { ownerKey }),
      { initialProps: { ownerKey: 'owner-a' } }
    );
    await waitFor(() => expect(onCreateRepo).toHaveBeenCalledTimes(1));
    rerender({ ownerKey: 'owner-b' });
    await waitFor(() => expect(onCreateRepo).toHaveBeenCalledTimes(2));
    await act(async () => fail(new Error('old owner')));
    expect(result.current.error).toBeUndefined();
  });
});
