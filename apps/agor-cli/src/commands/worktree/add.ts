/**
 * `agor worktree add <name>` - Create a git worktree
 *
 * Creates an isolated working directory for a specific branch.
 */

import type { Repo, Worktree } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class WorktreeAdd extends BaseCommand {
  static description = 'Create a git worktree for isolated development';

  static examples = [
    // Case 1: Create new branch (worktree name = branch name)
    '<%= config.bin %> <%= command.id %> feature-auth --repo-id 01933e4a',
    // Case 2: Create new branch with different name
    '<%= config.bin %> <%= command.id %> my-experiment --repo-id 01933e4a --branch feature-x',
    // Case 3: Checkout existing branch
    '<%= config.bin %> <%= command.id %> fix-api --repo-id 01933e4a --checkout',
    // Case 4: Checkout specific ref
    '<%= config.bin %> <%= command.id %> debug-session --repo-id 01933e4a --ref abc123def',
    // Case 5: Create branch from specific base
    '<%= config.bin %> <%= command.id %> feature-y --repo-id 01933e4a --from develop',
  ];

  static args = {
    name: Args.string({
      description: 'Worktree name (becomes branch name if creating new)',
      required: true,
    }),
  };

  static flags = {
    'repo-id': Flags.string({
      description: 'Repository ID',
      required: true,
    }),
    branch: Flags.string({
      char: 'b',
      description: 'Branch name (defaults to same as worktree name)',
    }),
    checkout: Flags.boolean({
      char: 'c',
      description: 'Checkout existing branch instead of creating new',
      default: false,
    }),
    ref: Flags.string({
      char: 'r',
      description: 'Checkout specific commit/tag (advanced)',
    }),
    from: Flags.string({
      char: 'f',
      description: 'Base branch for new branch (defaults to repo default branch)',
    }),
    'no-pull': Flags.boolean({
      description: 'Do not pull latest from remote before creating',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WorktreeAdd);
    const client = await this.connectToDaemon();

    try {
      const reposService = client.service('repos');

      // Fetch repo by ID
      const repo = (await reposService.get(flags['repo-id'])) as Repo;

      // Check if worktree already exists (query worktrees table)
      const worktreesService = client.service('worktrees');
      const worktreesList = (await worktreesService.findAll({
        query: {
          repo_id: repo.repo_id,
          name: args.name,
        },
      })) as Worktree[];
      if (worktreesList.length > 0) {
        this.error(`Worktree '${args.name}' already exists at ${worktreesList[0].path}`);
      }

      this.log('');
      this.log(
        chalk.bold(
          `Creating worktree ${chalk.cyan(args.name)} in repository ${chalk.cyan(flags['repo-id'])}...`
        )
      );
      this.log('');

      // Determine strategy and parameters
      let ref: string;
      let createBranch: boolean;
      let sourceBranch: string | undefined;
      let pullLatest = !flags['no-pull'];

      if (flags.ref) {
        // Case 4: Checkout specific commit/tag (advanced)
        ref = flags.ref;
        createBranch = false;
        pullLatest = false;
        this.log(chalk.dim(`  Checking out ${chalk.cyan(ref)} (detached HEAD)`));
      } else if (flags.checkout) {
        // Case 3: Checkout existing branch
        ref = flags.branch || args.name;
        createBranch = false;
        pullLatest = false;
        this.log(chalk.dim(`  Checking out existing branch ${chalk.cyan(ref)}`));
      } else {
        // Case 1, 2, 5: Create new branch
        ref = flags.branch || args.name;
        createBranch = true;
        sourceBranch = flags.from || repo.default_branch || 'main';

        this.log(
          chalk.dim(`  Creating new branch ${chalk.cyan(ref)} from ${chalk.cyan(sourceBranch)}`)
        );
        if (pullLatest) {
          this.log(chalk.dim(`  Pulling latest ${chalk.cyan(`origin/${sourceBranch}`)}`));
        }
      }

      // Call daemon API to create worktree
      const newWorktree = (await client.service('repos').createWorktree(repo.repo_id, {
        name: args.name,
        ref,
        createBranch,
        pullLatest,
        sourceBranch,
      })) as unknown as Worktree;

      this.log(`${chalk.green('✓')} Worktree created and registered`);
      this.log(chalk.dim(`  Path: ${newWorktree.path}`));

      this.log('');
      this.log(chalk.bold('Next steps:'));
      this.log(`  ${chalk.dim('cd')} ${newWorktree.path}`);
      this.log(
        `  ${chalk.dim('or start session:')} ${chalk.cyan(`agor session start --repo ${flags['repo-id']} --worktree ${args.name}`)}`
      );
      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
