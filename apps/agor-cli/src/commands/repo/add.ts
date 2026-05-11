/**
 * `agor repo add <url>` - Clone a repository for use with Agor
 *
 * Clones the repo to ~/.agor/repos/<name> and registers it with the daemon.
 */

import type { Repo } from '@agor-live/client';
import { extractSlugFromUrl, isValidGitUrl, isValidSlug } from '@agor-live/client';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

/** How long to wait for the async clone to land on the placeholder row. */
const CLONE_POLL_TIMEOUT_MS = 2 * 60 * 1000;
const CLONE_POLL_INTERVAL_MS = 1000;

export default class RepoAdd extends BaseCommand {
  static description = 'Clone a remote git repository and register it with Agor';

  static examples = [
    '# Clone from GitHub (SSH)',
    '<%= config.bin %> <%= command.id %> git@github.com:apache/superset.git',
    '',
    '# Clone from GitHub (HTTPS)',
    '<%= config.bin %> <%= command.id %> https://github.com/facebook/react.git',
    '',
    '# Custom slug',
    '<%= config.bin %> <%= command.id %> https://github.com/apache/superset.git --slug my-org/custom-name',
    '',
    '# Already have the repo locally?',
    '<%= config.bin %> repo add-local ~/code/myapp',
  ];

  static args = {
    url: Args.string({
      description: 'Git repository URL (SSH or HTTPS)',
      required: true,
    }),
  };

  static flags = {
    slug: Flags.string({
      char: 's',
      description: 'Custom slug (org/name) for the repository (auto-extracted if not provided)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoAdd);
    const client = await this.connectToDaemon();

    try {
      // Validate git URL format
      if (!isValidGitUrl(args.url)) {
        await this.cleanupClient(client);
        this.error(
          `Invalid git URL: ${args.url}\n\n` +
            `Please provide a valid git repository URL:\n` +
            `  SSH: ${chalk.cyan('git@github.com:apache/superset.git')}\n` +
            `  HTTPS: ${chalk.cyan('https://github.com/apache/superset.git')}\n\n` +
            `Note: Web page URLs like ${chalk.dim('github.com/org/repo')} are not valid.`
        );
      }

      // Extract slug from URL or use custom slug
      let slug = flags.slug;

      if (!slug) {
        // Auto-extract slug from URL (e.g., github.com/apache/superset -> apache/superset)
        slug = extractSlugFromUrl(args.url);
        this.log('');
        this.log(chalk.dim(`Auto-detected slug: ${chalk.cyan(slug)}`));
      }

      // Validate slug format
      if (!isValidSlug(slug)) {
        await this.cleanupClient(client);
        this.error(
          `Invalid slug format: ${slug}\n` +
            `Slug must be in format "org/name" with alphanumeric characters, dots, hyphens, or underscores\n` +
            `Examples: ${chalk.cyan('apache/superset')}, ${chalk.cyan('my-org/my.repo')}\n` +
            `Use --slug to specify a custom slug.`
        );
      }

      this.log('');
      this.log(chalk.bold(`Cloning ${chalk.cyan(slug)}...`));
      this.log(chalk.dim(`URL: ${args.url}`));
      this.log('');

      // Daemon returns `{ status, slug, repo_id }` immediately while the
      // clone runs in the background; the placeholder row carries
      // `clone_status: 'cloning'` and is patched to `'ready'`/`'failed'`
      // when the executor finishes. Use the route exposed at `/repos/clone`
      // (same path the UI calls) — there is no client method shortcut for it.
      const result = await client.service('repos/clone').create({
        url: args.url,
        name: slug,
        slug,
      });

      if (result.status === 'exists') {
        this.log(`${chalk.yellow('⚠')} Repository '${slug}' is already registered`);
        this.log(chalk.dim(`Use ${chalk.cyan('agor repo list')} to see registered repos.`));
        this.log('');
        await this.cleanupClient(client);
        return;
      }

      if (!result.repo_id) {
        // Defensive: pre-create path always returns repo_id, but if the
        // daemon ever stops including it we don't want the CLI to silently
        // hang on a missing target.
        this.log(chalk.yellow('⚠ Clone started but daemon did not return a repo_id.'));
        this.log(chalk.dim(`Run ${chalk.cyan('agor repo list')} to check progress.`));
        await this.cleanupClient(client);
        return;
      }

      // Poll `agor_repos_get` (via the standard Feathers get) until the
      // executor patches the placeholder. Bounded to CLONE_POLL_TIMEOUT_MS
      // so a hung executor cannot wedge the CLI indefinitely.
      const reposService = client.service('repos');
      const deadline = Date.now() + CLONE_POLL_TIMEOUT_MS;
      let repo: Repo | undefined;
      while (Date.now() < deadline) {
        const fetched = (await reposService.get(result.repo_id)) as Repo;
        if (fetched.clone_status === 'ready' || fetched.clone_status === undefined) {
          repo = fetched;
          break;
        }
        if (fetched.clone_status === 'failed') {
          const err = fetched.clone_error;
          const hint =
            err?.category === 'auth_failed'
              ? '\nConfigure GITHUB_TOKEN in Settings → API Keys for private repos.'
              : '';
          await this.cleanupClient(client);
          this.log('');
          this.log(chalk.red(`✗ Clone failed: ${err?.message ?? 'unknown error'}${hint}`));
          this.log('');
          this.exit(1);
        }
        await new Promise((resolve) => setTimeout(resolve, CLONE_POLL_INTERVAL_MS));
      }

      if (!repo) {
        await this.cleanupClient(client);
        this.log(chalk.red(`✗ Clone timed out after ${CLONE_POLL_TIMEOUT_MS / 1000}s.`));
        this.log(chalk.dim('Check daemon logs or run `agor repo list` to see current state.'));
        this.exit(1);
      }

      this.log(`${chalk.green('✓')} Repository cloned and registered`);
      this.log(chalk.dim(`  Path: ${repo.local_path}`));
      this.log(chalk.dim(`  Default branch: ${repo.default_branch}`));
      this.log('');
      this.log(chalk.bold('Repository Details:'));
      this.log(`  ${chalk.cyan('ID')}: ${repo.repo_id}`);
      this.log(`  ${chalk.cyan('Name')}: ${repo.name}`);
      this.log(`  ${chalk.cyan('Path')}: ${repo.local_path}`);
      this.log(`  ${chalk.cyan('Default Branch')}: ${repo.default_branch}`);
      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);

      const message = error instanceof Error ? error.message : String(error);

      this.log('');

      // Check for common errors and provide friendly messages
      if (message.includes('already exists')) {
        this.log(chalk.red('✗ Repository already exists'));
        this.log('');
        this.log(`Use ${chalk.cyan('agor repo list')} to see registered repos.`);
        this.log('');
        this.exit(1);
      }

      if (message.includes('Permission denied')) {
        this.log(chalk.red('✗ Permission denied'));
        this.log('');
        this.log('Make sure you have SSH keys configured or use HTTPS URL.');
        this.log('');
        this.exit(1);
      }

      if (message.includes('Could not resolve host')) {
        this.log(chalk.red('✗ Network error'));
        this.log('');
        this.log('Check your internet connection and try again.');
        this.log('');
        this.exit(1);
      }

      // Generic error
      this.log(chalk.red('✗ Failed to add repository'));
      this.log('');
      this.log(chalk.dim(message));
      this.log('');
      this.exit(1);
    }
  }
}
