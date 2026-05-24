import type { Application } from '@agor/core/feathers';
import type { HookContext, Repo, RepoID } from '@agor/core/types';
import {
  generateSessionToken,
  getDaemonUrl,
  spawnExecutorFireAndForget,
} from './spawn-executor.js';

/**
 * Daemon-side wrappers around the executor's `git.repo.realign-origin` command —
 * fire-and-forget, security-cleanup-only. Callers `.catch(...)` and continue.
 *
 * On drift, the executor emits the `[SECURITY]` log line. The previous URL is
 * deliberately not logged: drift may have come from a token-in-URL leak.
 */

/** Look up the repo row, then realign. Use when caller only has a repoId. */
export async function ensureRepoOriginAlignedById(app: Application, repoId: RepoID): Promise<void> {
  let repo: Repo;
  try {
    repo = (await app.service('repos').get(repoId)) as Repo;
  } catch {
    return;
  }
  return ensureRepoOriginAlignedForRepo(app, repo);
}

/** Realign using a Repo row the caller already has (no extra DB fetch before spawning). */
export async function ensureRepoOriginAlignedForRepo(app: Application, repo: Repo): Promise<void> {
  if (repo.repo_type !== 'remote') return;
  if (!repo.remote_url) return;
  if (!repo.local_path) return;

  const sessionToken = generateSessionToken(
    app as unknown as { settings: { authentication?: { secret?: string } } }
  );

  spawnExecutorFireAndForget(
    {
      command: 'git.repo.realign-origin',
      sessionToken,
      daemonUrl: getDaemonUrl(),
      params: {
        repoId: repo.repo_id,
      },
    },
    {
      logPrefix: `[git.repo.realign-origin ${repo.slug}]`,
    }
  );
}

/**
 * Filter: realign only when the patch changed `remote_url` or signalled
 * `clone_status: 'ready'`. Other patches don't change what the canonical URL
 * should be.
 */
export function shouldRealignAfterRepoPatch(patchData: Partial<Repo> | undefined): boolean {
  if (!patchData) return false;
  return Object.hasOwn(patchData, 'remote_url') || patchData.clone_status === 'ready';
}

/** Feathers `after.patch` hook — uses `context.result` directly, no re-fetch. */
export function realignRepoOriginAfterPatchHook() {
  return async (context: HookContext): Promise<HookContext> => {
    const patchData = context.data as Partial<Repo> | undefined;
    if (!shouldRealignAfterRepoPatch(patchData)) return context;

    const result = context.result as Repo | Repo[] | undefined;
    if (!result) return context;

    const repos = Array.isArray(result) ? result : [result];
    for (const repo of repos) {
      if (!repo?.repo_id) continue;
      ensureRepoOriginAlignedForRepo(context.app as Application, repo).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `⚠️  [repos.after.patch] ensureRepoOriginAlignedForRepo failed for repo ${repo.repo_id}: ${message}`
        );
      });
    }
    return context;
  };
}
