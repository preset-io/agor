import { BranchRepository, type Database, RepoRepository, shortId } from '@agor/core/db';
import { scrubGitConfigRemoteCredentials } from '@agor/core/git';

/**
 * Best-effort startup repair for credential-bearing git remote URLs.
 *
 * This runs only against remote repos managed by Agor and their branches. It
 * deliberately skips `repo_type: local` entries because those may point at an
 * operator's pre-existing repository outside `~/.agor`; mutating those configs
 * during daemon boot would be surprising. Local repos still get opportunistic
 * scrubbed at Agor git-operation boundaries and can be repaired explicitly via
 * `agor admin scrub-git-remotes --write`.
 */
export async function scrubManagedGitRemoteCredentials(db: Database): Promise<void> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);

  const repos = await repoRepo.findAll();
  const repoById = new Map(repos.map((repo) => [repo.repo_id, repo]));
  const remoteRepos = repos.filter((repo) => repo.repo_type === 'remote');
  const remoteRepoIds = new Set(remoteRepos.map((repo) => repo.repo_id));
  const branches = (await branchRepo.findAll({ includeArchived: true })).filter((branch) =>
    remoteRepoIds.has(branch.repo_id)
  );

  const repairedConfigPaths = new Set<string>();
  let repairedEntries = 0;

  for (const item of [
    ...remoteRepos.map((repo) => ({
      kind: 'repo' as const,
      label: `${repo.slug} (${shortId(repo.repo_id)})`,
      path: repo.local_path,
    })),
    ...branches.map((branch) => {
      const repo = repoById.get(branch.repo_id);
      return {
        kind: 'branch' as const,
        label: `${branch.name} (${shortId(branch.branch_id)}, repo=${repo?.slug ?? branch.repo_id})`,
        path: branch.path,
      };
    }),
  ]) {
    if (!item.path) continue;
    try {
      const result = await scrubGitConfigRemoteCredentials(item.path);
      if (result.findings.length === 0) continue;

      const newConfigPaths = result.findings
        .map((finding) => finding.configPath)
        .filter((configPath) => {
          if (repairedConfigPaths.has(configPath)) return false;
          repairedConfigPaths.add(configPath);
          return true;
        });

      repairedEntries += result.findings.length;
      console.warn(
        `🔒 SECURITY: scrubbed ${result.findings.length} credential-bearing git remote URL(s) from ${item.kind} ${item.label}. ` +
          `Affected git config file(s): ${newConfigPaths.length}. Rotate any exposed token(s).`
      );
    } catch (error) {
      console.warn(
        `[git-remote-scrub] Failed to scrub ${item.kind} ${item.label}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (repairedEntries > 0) {
    console.warn(
      `🔒 SECURITY: startup scrub removed URL userinfo from ${repairedEntries} git remote config entr${
        repairedEntries === 1 ? 'y' : 'ies'
      }. Rotate any token(s) that may have been exposed.`
    );
  }
}
