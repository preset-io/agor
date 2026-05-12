import { redactUrlUserinfo } from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import { ensureGitRemoteUrl } from '@agor/core/git';
import type { HookContext, Repo, RepoID } from '@agor/core/types';

/**
 * Daemon-side wrappers around `ensureGitRemoteUrl` — fire-and-forget,
 * security-cleanup-only. Callers `.catch(...)` and continue.
 *
 * On drift, emits a `[SECURITY]` log line. The PREVIOUS URL is deliberately
 * not logged: drift may have come from a token-in-URL leak.
 */

/** Look up the repo row, then realign. Use when caller only has a repoId. */
export async function ensureRepoOriginAlignedById(app: Application, repoId: RepoID): Promise<void> {
  let repo: Repo;
  try {
    repo = (await app.service('repos').get(repoId)) as Repo;
  } catch {
    return;
  }
  return ensureRepoOriginAlignedForRepo(repo);
}

/** Realign using a Repo row the caller already has (no extra DB fetch). */
export async function ensureRepoOriginAlignedForRepo(repo: Repo): Promise<void> {
  if (repo.repo_type !== 'remote') return;
  if (!repo.remote_url) return;
  if (!repo.local_path) return;

  const result = await ensureGitRemoteUrl(repo.local_path, 'origin', repo.remote_url);
  if (result.changed) {
    // Defense in depth — current validation rejects userinfo in remote_url
    // on write, but historical DB rows may predate that.
    console.warn(
      `[SECURITY] Realigned remote.origin.url for repo ${repo.repo_id} (slug=${repo.slug}); ` +
        `canonical URL now: ${redactUrlUserinfo(repo.remote_url)}`
    );
  }
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
      ensureRepoOriginAlignedForRepo(repo).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `⚠️  [repos.after.patch] ensureRepoOriginAlignedForRepo failed for repo ${repo.repo_id}: ${message}`
        );
      });
    }
    return context;
  };
}
