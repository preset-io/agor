import {
  BranchRepository,
  createDatabase,
  getDatabaseUrl,
  RepoRepository,
  shortId,
} from '../db/index.js';
import { scanGitConfigRemoteCredentials, scrubGitConfigRemoteCredentials } from '../git/exec.js';
import { getReporter, type LocalActionOptions } from './types.js';

export interface ScrubGitRemotesParams extends LocalActionOptions {
  write?: boolean;
  databaseUrl?: string;
}

export async function scrubGitRemotesAction(params: ScrubGitRemotesParams = {}): Promise<void> {
  const reporter = getReporter(params);
  const db = createDatabase({ url: params.databaseUrl ?? getDatabaseUrl() });
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const repos = await repoRepo.findAll();
  const branches = await branchRepo.findAll({ includeArchived: true });

  const seen = new Set<string>();
  let unsafeConfigUrls = 0;
  let changedConfigs = 0;
  let changedDbRows = 0;

  const dbScan = await repoRepo.scanRemoteUrls();
  const unsafeDbRows = dbScan.findings.length;
  if (unsafeDbRows > 0) {
    reporter.log(`persisted repo rows: ${unsafeDbRows} unsafe remote URL(s)`);
    for (const finding of dbScan.findings) {
      reporter.log(`  repo ${finding.slug} (${shortId(finding.repo_id)}): remote_url = <redacted>`);
    }
  }

  if (params.write) {
    const dbScrub = await repoRepo.scrubRemoteUrls();
    changedDbRows = dbScrub.changed;
    if (dbScrub.changed > 0) {
      reporter.log(
        `Scrubbed ${dbScrub.changed} persisted repo remote URL entr${
          dbScrub.changed === 1 ? 'y' : 'ies'
        }.`
      );
    }
  }

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
    const result = params.write
      ? await scrubGitConfigRemoteCredentials(item.path)
      : await scanGitConfigRemoteCredentials(item.path);
    const findings = result.findings.filter((finding) => {
      const key = `${finding.configPath}\0${finding.remote}\0${finding.key}\0${finding.sanitizedUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (findings.length === 0) continue;

    unsafeConfigUrls += findings.length;
    if ('changed' in result && result.changed) {
      changedConfigs += new Set(findings.map((finding) => finding.configPath)).size;
    }

    reporter.log(`${item.kind} ${item.label}: ${findings.length} unsafe remote URL(s)`);
    for (const finding of findings) {
      reporter.log(
        `  ${finding.configPath}: remote "${finding.remote}" ${finding.key} = ${finding.redactedUrl}`
      );
    }
  }

  if (unsafeDbRows === 0 && unsafeConfigUrls === 0) {
    reporter.log('No credential-bearing git remote URLs found.');
    return;
  }

  if (params.write) {
    reporter.log(
      `Scrubbed ${changedDbRows} persisted repo row(s) and ${unsafeConfigUrls} credential-bearing remote URL(s) across ${changedConfigs} config file(s).`
    );
  } else {
    reporter.log(
      `Found ${unsafeDbRows} persisted repo row(s) and ${unsafeConfigUrls} git config remote URL(s) with credential-bearing HTTP(S) userinfo. Re-run with --write to remove URL userinfo. Rotate any exposed token(s).`
    );
  }
}
