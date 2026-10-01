import type { Repo } from '@agor-live/client';
import { findFrameworkRepo } from '../hooks/useFrameworkRepo';

export interface WaitForFrameworkRepoReadyOptions {
  getRepoById: () => Map<string, Repo>;
  /** Called on every store change; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Writes the server's current repo rows into the store. */
  refreshRepos: () => Promise<void>;
  deadlineMs: number;
}

/**
 * Resolve the framework repo once it is `ready`, up to a hard deadline; never
 * hangs. The store can miss a clone's realtime outcome (#2941), so the server
 * is re-read before waiting and again at the deadline. Used at onboarding
 * completion so a user whose clone finished still gets their first teammate.
 */
export async function waitForFrameworkRepoReady({
  getRepoById,
  subscribe,
  refreshRepos,
  deadlineMs,
}: WaitForFrameworkRepoReadyOptions): Promise<Repo | undefined> {
  const findReady = () => findFrameworkRepo(getRepoById(), { readyOnly: true })?.[1];
  const refresh = () => refreshRepos().catch(() => undefined);

  if (!findReady()) await refresh();
  const readyNow = findReady();
  if (readyNow) return readyNow;

  return new Promise<Repo | undefined>((resolve) => {
    let settled = false;
    const finish = (repo: Repo | undefined) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(repo);
    };
    const check = () => {
      const ready = findReady();
      if (ready) finish(ready);
    };
    const unsubscribe = subscribe(check);
    const timer = setTimeout(() => {
      void refresh().then(() => finish(findReady()));
    }, deadlineMs);
    // Re-check in case readiness landed between the read above and subscribing.
    check();
  });
}
