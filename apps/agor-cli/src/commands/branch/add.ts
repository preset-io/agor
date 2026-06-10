/**
 * `agor branch add <name>` - Create a git branch
 *
 * Creates an isolated working directory for a specific branch.
 */

import type { Branch } from '@agor-live/client';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class BranchAdd extends BaseCommand {
  static description = 'Create a git branch for isolated development';

  static examples = [
    // Case 1: Create new branch (branch name = branch name)
    '<%= config.bin %> <%= command.id %> feature-auth --repo-id 01933e4a --board-id 01933e4b',
    // Case 2: Create new branch with different name
    '<%= config.bin %> <%= command.id %> my-experiment --repo-id 01933e4a --board-id 01933e4b --branch feature-x',
    // Case 3: Checkout existing branch
    '<%= config.bin %> <%= command.id %> fix-api --repo-id 01933e4a --board-id 01933e4b --checkout',
    // Case 4: Checkout specific ref
    '<%= config.bin %> <%= command.id %> debug-session --repo-id 01933e4a --board-id 01933e4b --ref abc123def',
    // Case 5: Create branch from specific base
    '<%= config.bin %> <%= command.id %> feature-y --repo-id 01933e4a --board-id 01933e4b --from develop',
  ];

  static args = {
    name: Args.string({
      description: 'Branch name (becomes branch name if creating new)',
      required: true,
    }),
  };

  static flags = {
    'repo-id': Flags.string({
      description: 'Repository ID',
      required: true,
    }),
    'board-id': Flags.string({
      description: 'Board ID',
      required: true,
    }),
    branch: Flags.string({
      char: 'b',
      description: 'Branch name (defaults to same as branch name)',
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
    const { args, flags } = await this.parse(BranchAdd);
    const client = await this.connectToDaemon();

    try {
      const reposService = client.service('repos');

      // Fetch repo by ID
      const repo = await reposService.get(flags['repo-id']);

      // Check if branch already exists (query branches table)
      const branchesService = client.service('branches');
      const branchesList = await branchesService.findAll({
        query: {
          repo_id: repo.repo_id,
          name: args.name,
        },
      });
      if (branchesList.length > 0) {
        this.error(`Branch '${args.name}' already exists at ${branchesList[0].path}`);
      }

      this.log('');
      this.log(
        chalk.bold(
          `Creating branch ${chalk.cyan(args.name)} in repository ${chalk.cyan(flags['repo-id'])}...`
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

      // Call daemon API to create branch
      const newBranch = (await client.service('repos').createBranch(repo.repo_id, {
        name: args.name,
        ref,
        createBranch,
        pullLatest,
        sourceBranch,
        boardId: flags['board-id'],
      })) as unknown as Branch;

      this.log(`${chalk.green('✓')} Branch created and registered`);
      this.log(chalk.dim(`  Path: ${newBranch.path}`));

      this.log('');
      this.log(chalk.bold('Next steps:'));
      this.log(`  ${chalk.dim('cd')} ${newBranch.path}`);
      this.log(
        `  ${chalk.dim('or start session:')} ${chalk.cyan(`agor session start --repo ${flags['repo-id']} --branch ${args.name}`)}`
      );
      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
