import type { Repo } from '@agor-live/client';
import { findFrameworkRepo } from '../hooks/useFrameworkRepo';

export interface WaitForFrameworkRepoReadyOptions {
  getRepoById: () => Map<string, Repo>;
  /** Called on every store change; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Reads the server's current repo rows. */
  fetchRepos: () => Promise<Repo[]>;
  /** Writes one server row into the store. */
  applyRepo: (repo: Repo) => void;
  deadlineMs: number;
  refreshEveryMs?: number;
}

/**
 * Resolve the framework repo once it is `ready`, or `undefined` once the server
 * confirms every framework clone failed or the hard deadline elapses; server
 * reads never extend the deadline. The store can miss a clone's realtime outcome
 * (#2941), so the server is re-read while waiting. Used at onboarding completion
 * so a user whose clone finished still gets their first teammate.
 */
export function waitForFrameworkRepoReady({
  getRepoById,
  subscribe,
  fetchRepos,
  applyRepo,
  deadlineMs,
  refreshEveryMs = 5_000,
}: WaitForFrameworkRepoReadyOptions): Promise<Repo | undefined> {
  const findReady = () => findFrameworkRepo(getRepoById(), { readyOnly: true })?.[1];
  const readyNow = findReady();
  if (readyNow) return Promise.resolve(readyNow);

  return new Promise<Repo | undefined>((resolve) => {
    let settled = false;
    let serverRead = false;
    let reading = false;
    let applying = false;
    let seen = getRepoById();
    // Rows the store dropped while a read was in flight; the read's copy is stale.
    const removedDuringRead = new Set<string>();

    const allFailed = () => {
      const repoById = getRepoById();
      return (
        !findFrameworkRepo(repoById, { excludeFailed: true }) &&
        findFrameworkRepo(repoById) !== undefined
      );
    };
    const check = () => {
      const ready = findReady();
      if (ready) finish(ready);
      else if (serverRead && allFailed()) finish(undefined);
    };
    const onStoreChange = () => {
      const current = getRepoById();
      if (reading && current !== seen) {
        for (const id of seen.keys()) if (!current.has(id)) removedDuringRead.add(id);
      }
      seen = current;
      if (!applying) check();
    };
    const refresh = async () => {
      if (reading || settled) return;
      reading = true;
      removedDuringRead.clear();
      seen = getRepoById();
      try {
        const repos = await fetchRepos();
        if (settled) return;
        applying = true;
        for (const repo of repos) if (!removedDuringRead.has(repo.repo_id)) applyRepo(repo);
        serverRead = true;
      } catch {
        // A failed read is retried on the next interval; the deadline still applies.
      } finally {
        applying = false;
        reading = false;
      }
      if (!settled) check();
    };

    const unsubscribe = subscribe(onStoreChange);
    const deadline = setTimeout(() => finish(findReady()), deadlineMs);
    const poll = setInterval(() => void refresh(), refreshEveryMs);
    function finish(repo: Repo | undefined) {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(deadline);
      clearInterval(poll);
      resolve(repo);
    }
    void refresh();
  });
}
