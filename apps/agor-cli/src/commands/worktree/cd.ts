/**
 * `agor worktree cd <worktree-id>` - Print worktree path for shell navigation
 *
 * Prints the absolute path to a worktree so you can easily navigate to it.
 * Designed to be used with a shell function like:
 *
 *   cd-worktree() { cd "$(agor worktree cd "$1")"; }
 *
 * Or add to your shell profile:
 *
 *   alias wtcd='cd "$(agor worktree cd "$1")"'
 */

import type { Worktree } from '@agor/core/types';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class WorktreeCd extends BaseCommand {
  static description = 'Print worktree path for shell navigation';

  static examples = [
    '<%= config.bin %> <%= command.id %> abc123',
    '<%= config.bin %> <%= command.id %> 01933e4a-b2c1-7890-a456-789012345678',
    '',
    '# Shell function for easy navigation:',
    'wtcd() { cd "$(agor worktree cd "$1")"; }',
    'wtcd abc123',
  ];

  static args = {
    worktreeId: Args.string({
      description: 'Worktree ID (full UUID or short ID)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(WorktreeCd);

    // Connect to daemon
    const client = await this.connectToDaemon();

    try {
      const worktreesService = client.service('worktrees');

      // Get worktree info
      const worktree = (await worktreesService.get(args.worktreeId)) as Worktree;

      // Print only the path (clean for shell consumption)
      this.log(worktree.path);

      // Cleanup
      await this.cleanupClient(client);
      process.exit(0);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to get worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
