/**
 * List all boards
 */

import type { BoardEntityObject } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { Flags } from '@oclif/core';
import chalk from 'chalk';
import Table from 'cli-table3';
import { BaseCommand } from '../../base-command';

export default class BoardList extends BaseCommand {
  static override description = 'List all boards';

  static override examples = ['<%= config.bin %> <%= command.id %>'];

  static override flags = {
    limit: Flags.integer({
      char: 'l',
      description: 'Maximum number of boards to show',
      default: PAGINATION.CLI_DEFAULT_LIMIT,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(BoardList);
    const client = await this.connectToDaemon();

    try {
      // Fetch all boards (high limit for accurate counts)
      const allBoards = await client
        .service('boards')
        .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } });

      if (allBoards.length === 0) {
        this.log(chalk.yellow('No boards found.'));
        await this.cleanupClient(client);
        return;
      }

      // Fetch all board objects to count worktrees per board
      const boardObjects = await client
        .service('board-objects')
        .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } });
      const typedBoardObjects = boardObjects as BoardEntityObject[];

      // Apply display limit
      const displayBoards = allBoards.slice(0, flags.limit);

      // Create table
      const table = new Table({
        head: [
          chalk.cyan('ID'),
          chalk.cyan('Name'),
          chalk.cyan('Worktrees'),
          chalk.cyan('Description'),
          chalk.cyan('Created'),
        ],
        colWidths: [12, 20, 12, 40, 12],
        wordWrap: true,
      });

      // Add rows
      for (const board of displayBoards) {
        const worktreeCount = typedBoardObjects.filter(
          (bo) => bo.board_id === board.board_id
        ).length;
        table.push([
          board.board_id.substring(0, 8),
          `${board.icon || '📋'} ${board.name}`,
          worktreeCount.toString(),
          board.description || '',
          new Date(board.created_at).toLocaleDateString(),
        ]);
      }

      this.log(table.toString());
      if (displayBoards.length < allBoards.length) {
        this.log(chalk.gray(`\nShowing ${displayBoards.length} of ${allBoards.length} board(s)`));
      } else {
        this.log(chalk.gray(`\nShowing ${displayBoards.length} board(s)`));
      }
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to fetch boards: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await this.cleanupClient(client);
  }
}
