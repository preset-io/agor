import {
  BranchRepository,
  createDatabase,
  getDatabaseUrl,
  RepoRepository,
  shortId,
} from '@agor/core/db';
import { scanGitConfigRemoteCredentials, scrubGitConfigRemoteCredentials } from '@agor/core/git';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

export default class ScrubGitRemotes extends Command {
  static override description =
    'Scan registered repos/branches for credential-bearing git remote URLs and optionally scrub them.';

  static override flags = {
    write: Flags.boolean({
      char: 'w',
      default: false,
      description:
        'Rewrite unsafe remote URLs in .git/config and persisted repo rows by removing URL userinfo',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ScrubGitRemotes);
    const db = createDatabase({ url: getDatabaseUrl() });
    const repoRepo = new RepoRepository(db);
    const branchRepo = new BranchRepository(db);
    const repos = await repoRepo.findAll();
    const branches = await branchRepo.findAll({ includeArchived: true });

    const seen = new Set<string>();
    let unsafeUrls = 0;
    let changedConfigs = 0;

    if (flags.write) {
      const dbScrub = await repoRepo.scrubRemoteUrls();
      if (dbScrub.changed > 0) {
        this.log(
          chalk.green(
            `Scrubbed ${dbScrub.changed} persisted repo remote URL entr${
              dbScrub.changed === 1 ? 'y' : 'ies'
            }.`
          )
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
      const result = flags.write
        ? await scrubGitConfigRemoteCredentials(item.path)
        : await scanGitConfigRemoteCredentials(item.path);
      const findings = result.findings.filter((finding) => {
        const key = `${finding.configPath}\0${finding.remote}\0${finding.key}\0${finding.sanitizedUrl}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (findings.length === 0) continue;

      unsafeUrls += findings.length;
      if ('changed' in result && result.changed) {
        changedConfigs += new Set(findings.map((finding) => finding.configPath)).size;
      }

      this.log(chalk.yellow(`${item.kind} ${item.label}: ${findings.length} unsafe remote URL(s)`));
      for (const finding of findings) {
        this.log(
          `  ${finding.configPath}: remote "${finding.remote}" ${finding.key} = ${finding.redactedUrl}`
        );
      }
    }

    if (unsafeUrls === 0) {
      this.log(chalk.green('No credential-bearing git remote URLs found.'));
      return;
    }

    if (flags.write) {
      this.log(
        chalk.green(
          `Scrubbed ${unsafeUrls} credential-bearing remote URL(s) across ${changedConfigs} config file(s).`
        )
      );
    } else {
      this.log(
        chalk.yellow(
          `Found ${unsafeUrls} credential-bearing remote URL(s). Re-run with --write to remove URL userinfo. Rotate any exposed token(s).`
        )
      );
    }
  }
}
