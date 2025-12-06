/**
 * List all boards
 */

import { PAGINATION } from '@agor/core/config';
import type { Board, BoardEntityObject } from '@agor/core/types';
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
      const result = await client
        .service('boards')
        .find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } });
      const allBoards = (Array.isArray(result) ? result : result.data) as Board[];

      if (allBoards.length === 0) {
        this.log(chalk.yellow('No boards found.'));
        await this.cleanupClient(client);
        return;
      }

      // Fetch all board objects to count worktrees per board
      const boardObjectsResult = await client
        .service('board-objects')
        .find({ query: { $limit: PAGINATION.DEFAULT_LIMIT } });
      const boardObjects = (
        Array.isArray(boardObjectsResult) ? boardObjectsResult : boardObjectsResult.data
      ) as BoardEntityObject[];

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
        const worktreeCount = boardObjects.filter((bo) => bo.board_id === board.board_id).length;
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
