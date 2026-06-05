import { BranchRepository, type Database, RepoRepository, shortId } from '@agor/core/db';
import { scanGitConfigRemoteCredentials } from '@agor/core/git';

/**
 * Startup health check for credential-bearing git remote URLs.
 *
 * This intentionally warns only. Repair is available through the core scrubber
 * and admin CLI; doing unexpected writes during daemon startup would be a
 * surprising side effect for operators.
 */
export async function warnOnManagedGitRemoteCredentials(db: Database): Promise<void> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);

  const repos = await repoRepo.findAll();
  const branches = await branchRepo.findAll({ includeArchived: true });
  const scannedConfigPaths = new Set<string>();
  let unsafeConfigs = 0;
  let unsafeUrls = 0;

  for (const item of [
    ...repos.map((repo) => ({
      kind: 'repo' as const,
      label: `${repo.slug} (${shortId(repo.repo_id)})`,
      path: repo.local_path,
    })),
    ...branches.map((branch) => ({
      kind: 'branch' as const,
      label: `${branch.name} (${shortId(branch.branch_id)})`,
      path: branch.path,
    })),
  ]) {
    if (!item.path) continue;
    try {
      const result = await scanGitConfigRemoteCredentials(item.path);
      const newFindings = result.findings.filter((finding) => {
        const key = `${finding.configPath}\0${finding.remote}\0${finding.key}\0${finding.sanitizedUrl}`;
        if (scannedConfigPaths.has(key)) return false;
        scannedConfigPaths.add(key);
        return true;
      });
      if (newFindings.length === 0) continue;

      unsafeConfigs += new Set(newFindings.map((f) => f.configPath)).size;
      unsafeUrls += newFindings.length;
      const details = newFindings
        .map((finding) => `${finding.remote}.${finding.key}=${finding.redactedUrl}`)
        .join(', ');
      console.warn(
        `🔒 SECURITY: ${item.kind} ${item.label} has credential-bearing git remote URL(s) in ${newFindings.length} config entr${newFindings.length === 1 ? 'y' : 'ies'}; ${details}. ` +
          `Remove the embedded credentials and rotate the token(s).`
      );
    } catch (error) {
      console.warn(
        `[git-remote-scan] Failed to scan ${item.kind} ${item.label}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (unsafeUrls > 0) {
    console.warn(
      `🔒 SECURITY: found ${unsafeUrls} credential-bearing git remote URL(s) across ${unsafeConfigs} git config file(s). ` +
        `Run the admin repair utility or remove credentials from remotes manually; rotate any exposed tokens.`
    );
  }
}
