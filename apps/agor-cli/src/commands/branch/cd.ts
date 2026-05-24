/**
 * `agor branch cd <branch-id>` - Navigate to a branch
 *
 * Opens a new shell in the specified branch directory.
 * Type `exit` to return to your original shell.
 *
 * Use --print flag to output the path instead (for shell functions):
 *   wtcd() { cd "$(agor branch cd --print "$1")"; }
 */

import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import { spawnInteractiveShell } from '../../utils/shell';

export default class BranchCd extends BaseCommand {
  static description = 'Navigate to a branch (opens a new shell)';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> 01933e4a-b2c1-7890-a456-789012345678',
    '',
    '# Print path instead of spawning shell:',
    '<%= config.bin %> <%= command.id %> --print abc123',
    '',
    '# Shell function for cd without spawning:',
    'wtcd() { cd "$(agor branch cd --print "$1")"; }',
  ];

  static args = {
    branchId: Args.string({
      description: 'Branch ID (full UUID or short ID)',
      required: true,
    }),
  };

  static flags = {
    print: Flags.boolean({
      description: 'Print path instead of spawning a shell',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchCd);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const branchesService = client.service('branches');

      // Get branch info
      const branch = await branchesService.get(args.branchId);

      // If --print flag is set, just print the path
      if (flags.print) {
        this.log(branch.path);
        await this.cleanupClient(client);
        process.exit(0);
        return;
      }

      // Cleanup client before spawning shell
      await this.cleanupClient(client);

      // Display info message
      this.log('');
      this.log(`${chalk.cyan('→')} Opening shell in branch: ${chalk.bold(branch.name)}`);
      this.log(`${chalk.dim('  Path:')} ${branch.path}`);
      this.log(`${chalk.dim('  Type')} ${chalk.cyan('exit')} ${chalk.dim('to return')}`);
      this.log('');

      // Spawn interactive shell in the branch directory
      spawnInteractiveShell({
        cwd: branch.path,
        env: {
          AGOR_BRANCH_ID: branch.branch_id,
          AGOR_BRANCH_NAME: branch.name,
        },
        onExit: (code) => {
          this.log('');
          this.log(`${chalk.dim('← Exited branch shell')}`);
          process.exit(code || 0);
        },
        onError: (error) => {
          this.error(`Failed to spawn shell: ${error.message}`);
        },
      });
    } catch (error) {
      await this.cleanupClient(client);
      this.error(`Failed to get branch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
