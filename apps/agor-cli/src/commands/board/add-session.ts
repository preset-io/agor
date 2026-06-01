/**
 * Add a session's branch to a board
 *
 * Note: Sessions are now organized through branches. This command adds
 * the session's branch to the board, which will display all sessions
 * associated with that branch.
 */

import type { Board, BoardEntityObject, Branch, Session } from '@agor-live/client';
import { PAGINATION, shortId } from '@agor-live/client';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class BoardAddSession extends BaseCommand {
  static override description =
    "Add a session's branch to a board (sessions are organized through branches)";

  static override examples = [
    '<%= config.bin %> <%= command.id %> default 0199b86c',
    '<%= config.bin %> <%= command.id %> 0199b850 0199b86c-10ab-7409-b053-38b62327e695',
  ];

  static override args = {
    boardId: Args.string({
      description: 'Board ID or slug',
      required: true,
    }),
    sessionId: Args.string({
      description: 'Session ID (short or full)',
      required: true,
    }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(BoardAddSession);
    const client = await this.connectToDaemon();

    try {
      // Find board by ID or slug
      const boards = await client
        .service('boards')
        .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } });

      const board = boards.find(
        (b: Board) =>
          b.board_id === args.boardId ||
          b.board_id.startsWith(args.boardId) ||
          b.slug === args.boardId
      );

      if (!board) {
        await this.cleanupClient(client);
        this.error(`Board not found: ${args.boardId}`);
      }

      // Find session by short or full ID
      const sessions = await client
        .service('sessions')
        .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } });

      const session = sessions.find(
        (s: Session) => s.session_id === args.sessionId || s.session_id.startsWith(args.sessionId)
      );

      if (!session) {
        await this.cleanupClient(client);
        this.error(`Session not found: ${args.sessionId}`);
      }

      // Get branch for this session
      if (!session.branch_id) {
        await this.cleanupClient(client);
        this.error('Session has no branch associated');
      }

      const branches = await client
        .service('branches')
        .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } });

      const branch = branches.find((w: Branch) => w.branch_id === session.branch_id);

      if (!branch) {
        await this.cleanupClient(client);
        this.error('Branch not found for session');
      }

      // Check if branch is already on the board
      const boardObjects = await client.service('board-objects').findAll({
        query: {
          board_id: board.board_id,
        },
      });
      const typedBoardObjects = boardObjects as BoardEntityObject[];

      const existingObject = typedBoardObjects.find(
        (bo: BoardEntityObject) => bo.branch_id === branch.branch_id
      );

      if (existingObject) {
        this.log(chalk.yellow(`⚠ Branch "${branch.name}" already on board "${board.name}"`));
        await this.cleanupClient(client);
        return;
      }

      // Add branch to board via board_objects
      await client.service('board-objects').create({
        board_id: board.board_id,
        branch_id: branch.branch_id,
        position: { x: 100, y: 100 },
      });

      this.log(
        chalk.green(
          `✓ Added branch "${branch.name}" (containing session ${shortId(session.session_id)}) to board "${board.name}"`
        )
      );
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to add session to board: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await this.cleanupClient(client);
  }
}
