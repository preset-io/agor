import { RepoRepository, type TenantScopeAwareDatabase } from '@agor/core/db';

/**
 * Best-effort startup repair for credential-bearing git remote URLs.
 *
 * This repairs persisted repo.remote_url rows for all registered repos, because
 * those values are Agor-owned metadata. Filesystem .git/config scrubbing runs
 * only against remote repos managed by Agor and their branches; it deliberately
 * skips `repo_type: local` entries because those may point at an operator's
 * pre-existing repository outside `~/.agor`, and mutating those configs during
 * daemon boot would be surprising. Local repos still get opportunistically
 * scrubbed at Agor git-operation boundaries and can be repaired explicitly via
 * `agor local scrub-git-remotes --write`.
 */
export async function scrubManagedGitRemoteCredentials(
  db: TenantScopeAwareDatabase
): Promise<void> {
  const repoRepo = new RepoRepository(db);
  try {
    const dbScrub = await repoRepo.scrubRemoteUrls();
    if (dbScrub.changed > 0) {
      console.warn(
        `🔒 SECURITY: scrubbed credential-bearing URL userinfo from ${dbScrub.changed} persisted repo remote URL entr${
          dbScrub.changed === 1 ? 'y' : 'ies'
        }. Rotate any token(s) that may have been exposed.`
      );
    }
  } catch (error) {
    console.warn(
      `[git-remote-scrub] Failed to scrub persisted repo remote URLs: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
