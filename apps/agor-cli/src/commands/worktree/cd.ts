/**
 * `agor worktree cd <worktree-id>` - Navigate to a worktree
 *
 * Opens a new shell in the specified worktree directory.
 * Type `exit` to return to your original shell.
 *
 * Use --print flag to output the path instead (for shell functions):
 *   wtcd() { cd "$(agor worktree cd --print "$1")"; }
 */

import type { Worktree } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import { spawnInteractiveShell } from '../../utils/shell';

export default class WorktreeCd extends BaseCommand {
  static description = 'Navigate to a worktree (opens a new shell)';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> 01933e4a-b2c1-7890-a456-789012345678',
    '',
    '# Print path instead of spawning shell:',
    '<%= config.bin %> <%= command.id %> --print abc123',
    '',
    '# Shell function for cd without spawning:',
    'wtcd() { cd "$(agor worktree cd --print "$1")"; }',
  ];

  static args = {
    worktreeId: Args.string({
      description: 'Worktree ID (full UUID or short ID)',
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
    const { args, flags } = await this.parse(WorktreeCd);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Get worktree info
      const worktree = (await worktreesService.get(args.worktreeId)) as Worktree;

      // If --print flag is set, just print the path
      if (flags.print) {
        this.log(worktree.path);
        await this.cleanupClient(client);
        process.exit(0);
        return;
      }

      // Cleanup client before spawning shell
      await this.cleanupClient(client);

      // Display info message
      this.log('');
      this.log(`${chalk.cyan('→')} Opening shell in worktree: ${chalk.bold(worktree.name)}`);
      this.log(`${chalk.dim('  Path:')} ${worktree.path}`);
      this.log(`${chalk.dim('  Type')} ${chalk.cyan('exit')} ${chalk.dim('to return')}`);
      this.log('');

      // Spawn interactive shell in the worktree directory
      spawnInteractiveShell({
        cwd: worktree.path,
        env: {
          AGOR_WORKTREE_ID: worktree.worktree_id,
          AGOR_WORKTREE_NAME: worktree.name,
        },
        onExit: code => {
          this.log('');
          this.log(`${chalk.dim('← Exited worktree shell')}`);
          process.exit(code || 0);
        },
        onError: error => {
          this.error(`Failed to spawn shell: ${error.message}`);
        },
      });
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to get worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
