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
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  let serverRepos: Repo[] = [];
  const fetchRepos = vi.fn(async () => serverRepos);
  const wait = () =>
    waitForFrameworkRepoReady({
      getRepoById: () => repoById,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      fetchRepos,
      applyRepo: (r) => {
        repoById = new Map(repoById).set(r.repo_id, r);
        notify();
      },
      deadlineMs: 20_000,
    });
  return {
    listeners,
    fetchRepos,
    wait,
    getRepoById: () => repoById,
    setServerRepos: (repos: Repo[]) => {
      serverRepos = repos;
    },
    put: (r: Repo) => {
      repoById = new Map(repoById).set(r.repo_id, r);
      notify();
    },
    remove: (id: string) => {
      repoById = new Map(repoById);
      repoById.delete(id);
      notify();
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
  it('reads the server when the store missed the ready event', async () => {
    const { setServerRepos, wait } = setup([repo('cloning')]);
    setServerRepos([repo('ready')]);

    await expect(wait()).resolves.toEqual(repo('ready'));
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

  it('re-reads the server while waiting', async () => {
    const { fetchRepos, setServerRepos, wait } = setup([repo('cloning')]);
    setServerRepos([repo('cloning')]);

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    setServerRepos([repo('ready')]);
    await vi.advanceTimersByTimeAsync(5_000);

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

  it('keeps the deadline hard when a server read never settles', async () => {
    const { fetchRepos, wait } = setup([repo('cloning')]);
    fetchRepos.mockReturnValue(new Promise<Repo[]>(() => {}));

    const pending = wait();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops waiting once the server confirms the clone failed', async () => {
    const { setServerRepos, wait } = setup([repo('cloning')]);
    setServerRepos([repo('failed')]);

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toBeUndefined();
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

  it('does not restore a row the store removed while the read was in flight', async () => {
    const { fetchRepos, getRepoById, remove, wait } = setup([
      repo('failed', 'repo-old'),
      repo('cloning'),
    ]);
    let respond: (repos: Repo[]) => void = () => {};
    fetchRepos.mockReturnValueOnce(new Promise<Repo[]>((r) => (respond = r)));

    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    remove('repo-old');
    respond([repo('failed', 'repo-old'), repo('ready')]);

    await expect(pending).resolves.toEqual(repo('ready'));
    expect(getRepoById().has('repo-old')).toBe(false);
  });
});
