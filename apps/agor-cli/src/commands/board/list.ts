/**
 * List all boards
 */

import type { Board, BoardEntityObject } from '@agor/core/types';
import chalk from 'chalk';
import Table from 'cli-table3';
import { BaseCommand } from '../../base-command';

export default class BoardList extends BaseCommand {
  static override description = 'List all boards';

  static override examples = ['<%= config.bin %> <%= command.id %>'];

  public async run(): Promise<void> {
    await this.parse(BoardList);
    const client = await this.connectToDaemon();

    try {
      // Fetch all boards (handle pagination)
      const result = await client.service('boards').find({ query: { $limit: -1 } });
      const boards = (Array.isArray(result) ? result : result.data) as Board[];

      if (boards.length === 0) {
        this.log(chalk.yellow('No boards found.'));
        await this.cleanupClient(client);
        return;
      }

      // Fetch all board objects to count worktrees per board (handle pagination)
      const boardObjectsResult = await client
        .service('board-objects')
        .find({ query: { $limit: -1 } });
      const boardObjects = (
        Array.isArray(boardObjectsResult) ? boardObjectsResult : boardObjectsResult.data
      ) as BoardEntityObject[];

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
      for (const board of boards) {
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
      this.log(chalk.gray(`\nTotal: ${boards.length} board(s)`));
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to fetch boards: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await this.cleanupClient(client);
  }
}
