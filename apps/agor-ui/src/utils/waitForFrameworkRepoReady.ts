import type { Repo } from '@agor-live/client';
import { findFrameworkRepo } from '../hooks/useFrameworkRepo';

export interface WaitForFrameworkRepoReadyOptions {
  getRepoById: () => Map<string, Repo>;
  /** Called on every store change; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Reads the server's current repo rows. */
  fetchRepos: () => Promise<Repo[]>;
  /** Writes a server row over the store's stale copy. */
  applyRepo: (repo: Repo) => void;
  deadlineMs: number;
  /** Cap on the server read made at the deadline. */
  finalReadMs?: number;
  /** Fence asynchronous reads when the authenticated owner changes. */
  isCurrent?: () => boolean;
}

const readyIn = (repoById: Map<string, Repo>) =>
  findFrameworkRepo(repoById, { readyOnly: true })?.[1];

/**
 * Resolve the framework repo once it is `ready`, or `undefined` once the server
 * shows every framework clone failed or the deadline (plus at most `finalReadMs`
 * for one last server read) elapses. The store can miss a clone's realtime
 * outcome (#2941), so the server is read before waiting and again at the
 * deadline. Used at onboarding completion so a user whose clone finished still
 * gets their first teammate.
 */
export function waitForFrameworkRepoReady({
  getRepoById,
  subscribe,
  fetchRepos,
  applyRepo,
  deadlineMs,
  finalReadMs = 2_000,
  isCurrent = () => true,
}: WaitForFrameworkRepoReadyOptions): Promise<Repo | undefined> {
  if (!isCurrent()) return Promise.resolve(undefined);
  const initialIds = new Set(getRepoById().keys());
  const readyNow = readyIn(getRepoById());
  if (readyNow) return Promise.resolve(readyNow);

  return new Promise<Repo | undefined>((resolve) => {
    let settled = false;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (!isCurrent()) {
        finish(undefined);
        return;
      }
      const ready = readyIn(getRepoById());
      if (ready) finish(ready);
    };
    // Recover missed created events, but never restore a row removed during this wait.
    const read = () =>
      Promise.resolve()
        .then(fetchRepos)
        .then((repos) => {
          if (settled) return;
          if (!isCurrent()) {
            finish(undefined);
            return;
          }
          const store = getRepoById();
          const server = new Map(
            repos
              .filter((repo) => store.has(repo.repo_id) || !initialIds.has(repo.repo_id))
              .map((repo) => [repo.repo_id, repo])
          );
          const ready = readyIn(server);
          const best = findFrameworkRepo(server)?.[1];
          if (ready) {
            applyRepo(ready);
            finish(ready);
          } else if (best && !findFrameworkRepo(server, { excludeFailed: true })) {
            // Every held framework clone failed; apply the row the UI shows so it stops reading as cloning.
            applyRepo(best);
            finish(undefined);
          }
        })
        .catch(() => undefined);

    const unsubscribe = subscribe(check);
    const deadline = setTimeout(() => {
      const settleFromStore = () => finish(readyIn(getRepoById()));
      finalTimer = setTimeout(settleFromStore, finalReadMs);
      void read().then(settleFromStore);
    }, deadlineMs);
    function finish(repo: Repo | undefined) {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(deadline);
      clearTimeout(finalTimer);
      resolve(isCurrent() ? repo : undefined);
    }
    // Re-check in case readiness landed between the check above and subscribing.
    check();
    void read();
  });
}
