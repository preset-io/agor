import type { Repo } from '@agor-live/client';
import { findFrameworkRepo } from '../hooks/useFrameworkRepo';

export interface WaitForFrameworkRepoReadyOptions {
  getRepoById: () => Map<string, Repo>;
  /** Called on every store change; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Reads the server's current repo rows. */
  fetchRepos: () => Promise<Repo[]>;
  /** Writes the server's ready row over the store's stale copy. */
  applyRepo: (repo: Repo) => void;
  /** False once the caller no longer wants the result. */
  isCurrent: () => boolean;
  deadlineMs: number;
  refreshEveryMs?: number;
  /** Cap on the server read made at the deadline. */
  finalReadMs?: number;
}

const readyIn = (repoById: Map<string, Repo>) =>
  findFrameworkRepo(repoById, { readyOnly: true })?.[1];

const allFailedIn = (repoById: Map<string, Repo>) =>
  !findFrameworkRepo(repoById, { excludeFailed: true }) && !!findFrameworkRepo(repoById);

/**
 * Resolve the framework repo once it is `ready`, or `undefined` once the server
 * shows every framework clone failed, the caller is no longer current, or the
 * deadline (plus at most `finalReadMs` for one last server read) elapses. The
 * store can miss a clone's realtime outcome (#2941), so the server is re-read
 * while waiting. Used at onboarding completion so a user whose clone finished
 * still gets their first teammate.
 */
export function waitForFrameworkRepoReady({
  getRepoById,
  subscribe,
  fetchRepos,
  applyRepo,
  isCurrent,
  deadlineMs,
  refreshEveryMs = 5_000,
  finalReadMs = 2_000,
}: WaitForFrameworkRepoReadyOptions): Promise<Repo | undefined> {
  const readyNow = readyIn(getRepoById());
  if (readyNow) return Promise.resolve(readyNow);

  return new Promise<Repo | undefined>((resolve) => {
    let settled = false;
    let seen = getRepoById();
    let polling = false;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    // Rows the store dropped during the wait; an older server copy must not bring them back.
    const removed = new Set<string>();

    const evaluate = (repos: Repo[]) => {
      if (settled) return;
      if (!isCurrent()) return finish(undefined);
      const server = new Map(repos.map((repo) => [repo.repo_id, repo]));
      const ready = readyIn(server);
      if (ready) {
        if (!removed.has(ready.repo_id)) applyRepo(ready);
        finish(ready);
      } else if (allFailedIn(server)) {
        finish(undefined);
      }
    };
    const read = () => {
      if (!isCurrent()) {
        finish(undefined);
        return Promise.resolve();
      }
      return fetchRepos()
        .then(evaluate)
        .catch(() => undefined);
    };
    // Polls skip while a read is outstanding; the deadline read below always fetches fresh.
    const pollOnce = () => {
      if (polling) return;
      polling = true;
      void read().finally(() => {
        polling = false;
      });
    };
    const onStoreChange = () => {
      if (!isCurrent()) return finish(undefined);
      const repoById = getRepoById();
      if (repoById === seen) return;
      for (const id of seen.keys()) if (!repoById.has(id)) removed.add(id);
      seen = repoById;
      const ready = readyIn(repoById);
      if (ready) finish(ready);
    };

    const unsubscribe = subscribe(onStoreChange);
    // Registered before the poll so a tick at the deadline is replaced by the fresh final read.
    const deadline = setTimeout(() => {
      clearInterval(poll);
      const settleFromStore = () => finish(readyIn(getRepoById()));
      finalTimer = setTimeout(settleFromStore, finalReadMs);
      void read().then(settleFromStore);
    }, deadlineMs);
    const poll = setInterval(pollOnce, refreshEveryMs);
    function finish(repo: Repo | undefined) {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearInterval(poll);
      clearTimeout(deadline);
      clearTimeout(finalTimer);
      resolve(repo);
    }
    pollOnce();
  });
}
