import type { Repo } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAMEWORK_REPO_SLUG } from '../hooks/useFrameworkRepo';
import { waitForFrameworkRepoReady } from './waitForFrameworkRepoReady';

function repo(clone_status: Repo['clone_status']): Repo {
  return { repo_id: 'repo-fw', slug: FRAMEWORK_REPO_SLUG, clone_status } as Repo;
}

function setup(initial: Repo[]) {
  const repoById = new Map(initial.map((r) => [r.repo_id, r]));
  const listeners = new Set<() => void>();
  let serverRepos: Repo[] = [];
  const refreshRepos = vi.fn(async () => {
    for (const r of serverRepos) repoById.set(r.repo_id, r);
  });
  const wait = () =>
    waitForFrameworkRepoReady({
      getRepoById: () => repoById,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refreshRepos,
      deadlineMs: 20_000,
    });
  return {
    listeners,
    refreshRepos,
    wait,
    setServerRepos: (repos: Repo[]) => {
      serverRepos = repos;
    },
    put: (r: Repo) => {
      repoById.set(r.repo_id, r);
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('waitForFrameworkRepoReady', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a ready repo without reading the server', async () => {
    const { refreshRepos, wait } = setup([repo('ready')]);

    await expect(wait()).resolves.toEqual(repo('ready'));
    expect(refreshRepos).not.toHaveBeenCalled();
  });

  // #2941: the server had the repo ready but the store never saw it, so completion gave up after 20s.
  it('reads the server before waiting when the store missed the ready event', async () => {
    const { setServerRepos, wait } = setup([repo('cloning')]);
    setServerRepos([repo('ready')]);

    await expect(wait()).resolves.toEqual(repo('ready'));
  });

  it('resolves when the store sees readiness during the wait', async () => {
    const { listeners, put, wait } = setup([repo('cloning')]);

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    put(repo('ready'));

    await expect(pending).resolves.toEqual(repo('ready'));
    expect(listeners.size).toBe(0);
  });

  it('re-reads the server at the deadline', async () => {
    const { refreshRepos, setServerRepos, wait } = setup([repo('cloning')]);

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    setServerRepos([repo('ready')]);
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toEqual(repo('ready'));
    expect(refreshRepos).toHaveBeenCalledTimes(2);
  });

  it('resolves undefined at the deadline when the clone is still running, even if reads fail', async () => {
    const { listeners, refreshRepos, wait } = setup([repo('cloning')]);
    refreshRepos.mockRejectedValue(new Error('offline'));

    const pending = wait();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toBeUndefined();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
