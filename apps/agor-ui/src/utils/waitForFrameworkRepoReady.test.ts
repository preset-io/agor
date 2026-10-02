import type { Repo } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAMEWORK_REPO_SLUG } from '../hooks/useFrameworkRepo';
import { waitForFrameworkRepoReady } from './waitForFrameworkRepoReady';

function repo(clone_status: Repo['clone_status'], repo_id = 'repo-fw'): Repo {
  return { repo_id, slug: FRAMEWORK_REPO_SLUG, clone_status } as Repo;
}

function setup(initial: Repo[]) {
  let repoById = new Map(initial.map((r) => [r.repo_id, r]));
  const listeners = new Set<() => void>();
  let serverRepos: Repo[] = [];
  const put = (r: Repo) => {
    repoById = new Map(repoById).set(r.repo_id, r);
    for (const listener of [...listeners]) listener();
  };
  const fetchRepos = vi.fn(async () => serverRepos);
  const applyRepo = vi.fn(put);
  const wait = () =>
    waitForFrameworkRepoReady({
      getRepoById: () => repoById,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      fetchRepos,
      applyRepo,
      deadlineMs: 20_000,
    });
  return {
    applyRepo,
    fetchRepos,
    listeners,
    put,
    wait,
    getRepoById: () => repoById,
    setServerRepos: (repos: Repo[]) => {
      serverRepos = repos;
    },
    remove: (id: string) => {
      repoById = new Map(repoById);
      repoById.delete(id);
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('waitForFrameworkRepoReady', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a ready repo without reading the server', async () => {
    const { fetchRepos, wait } = setup([repo('ready')]);

    await expect(wait()).resolves.toEqual(repo('ready'));
    expect(fetchRepos).not.toHaveBeenCalled();
  });

  // #2941: the server had the repo ready but the store never saw it, so completion gave up after 20s.
  it('reads the server when the store missed the ready event, and refreshes the stale row', async () => {
    const { getRepoById, setServerRepos, wait } = setup([repo('cloning')]);
    setServerRepos([repo('ready')]);

    await expect(wait()).resolves.toEqual(repo('ready'));
    expect(getRepoById().get('repo-fw')?.clone_status).toBe('ready');
  });

  it('resolves when the store sees readiness during the wait', async () => {
    const { listeners, put, setServerRepos, wait } = setup([repo('cloning')]);
    setServerRepos([repo('cloning')]);

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    put(repo('ready'));

    await expect(pending).resolves.toEqual(repo('ready'));
    expect(listeners.size).toBe(0);
  });

  it('re-reads the server at the deadline', async () => {
    const { fetchRepos, setServerRepos, wait } = setup([repo('cloning')]);
    setServerRepos([repo('cloning')]);

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    setServerRepos([repo('ready')]);
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toEqual(repo('ready'));
    expect(fetchRepos).toHaveBeenCalledTimes(2);
  });

  it('resolves undefined at the deadline when the clone is still running, even if reads fail', async () => {
    const { fetchRepos, listeners, wait } = setup([repo('cloning')]);
    fetchRepos.mockRejectedValue(new Error('offline'));

    const pending = wait();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toBeUndefined();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps the wait at the deadline plus the final read when server reads never settle', async () => {
    const { fetchRepos, wait } = setup([repo('cloning')]);
    fetchRepos.mockReturnValue(new Promise<Repo[]>(() => {}));

    const pending = wait();
    await vi.advanceTimersByTimeAsync(22_000);

    await expect(pending).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a synchronous fetch failure like a failed read', async () => {
    const { fetchRepos, wait } = setup([repo('cloning')]);
    fetchRepos.mockImplementation(() => {
      throw new Error('client torn down');
    });

    const pending = wait();
    await vi.advanceTimersByTimeAsync(22_000);

    await expect(pending).resolves.toBeUndefined();
  });

  it('stops waiting once the server shows the clone failed, and refreshes the stale row', async () => {
    const { getRepoById, setServerRepos, wait } = setup([repo('cloning')]);
    setServerRepos([repo('failed')]);

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toBeUndefined();
    expect(getRepoById().get('repo-fw')?.clone_status).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps waiting while a retry clone is still running', async () => {
    const { put, setServerRepos, wait } = setup([repo('failed'), repo('cloning', 'repo-retry')]);
    setServerRepos([repo('failed'), repo('cloning', 'repo-retry')]);

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    put(repo('ready', 'repo-retry'));

    await expect(pending).resolves.toEqual(repo('ready', 'repo-retry'));
  });

  it('does not use or restore a row the store removed while the read was in flight', async () => {
    const { applyRepo, fetchRepos, getRepoById, remove, wait } = setup([repo('cloning')]);
    let respond: (repos: Repo[]) => void = () => {};
    fetchRepos.mockReturnValueOnce(new Promise<Repo[]>((r) => (respond = r)));

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    remove('repo-fw');
    respond([repo('ready')]);
    await vi.advanceTimersByTimeAsync(22_000);

    await expect(pending).resolves.toBeUndefined();
    expect(applyRepo).not.toHaveBeenCalled();
    expect(getRepoById().has('repo-fw')).toBe(false);
  });
});
