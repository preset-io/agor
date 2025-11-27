/**
 * Add a session's worktree to a board
 *
 * Note: Sessions are now organized through worktrees. This command adds
 * the session's worktree to the board, which will display all sessions
 * associated with that worktree.
 */

import type { Board, BoardEntityObject, Session, Worktree } from '@agor/core/types';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class BoardAddSession extends BaseCommand {
  static override description =
    "Add a session's worktree to a board (sessions are organized through worktrees)";

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
      // Find board by ID or slug (fetch all boards)
      const boardsResult = await client.service('boards').find({ query: { $limit: -1 } });
      const boards = (Array.isArray(boardsResult) ? boardsResult : boardsResult.data) as Board[];

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

      // Find session by short or full ID (fetch all sessions)
      const sessionsResult = await client.service('sessions').find({ query: { $limit: -1 } });
      const sessions = (
        Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data
      ) as Session[];

      const session = sessions.find(
        (s: Session) => s.session_id === args.sessionId || s.session_id.startsWith(args.sessionId)
      );

      if (!session) {
        await this.cleanupClient(client);
        this.error(`Session not found: ${args.sessionId}`);
      }

      // Get worktree for this session
      if (!session.worktree_id) {
        await this.cleanupClient(client);
        this.error('Session has no worktree associated');
      }

      const worktreesResult = await client.service('worktrees').find({ query: { $limit: -1 } });
      const worktrees = (
        Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data
      ) as Worktree[];

      const worktree = worktrees.find((w: Worktree) => w.worktree_id === session.worktree_id);

      if (!worktree) {
        await this.cleanupClient(client);
        this.error('Worktree not found for session');
      }

      // Check if worktree is already on the board
      const boardObjectsResult = await client.service('board-objects').find({
        query: {
          board_id: board.board_id,
        },
      });

      const boardObjects = (
        Array.isArray(boardObjectsResult) ? boardObjectsResult : boardObjectsResult.data
      ) as BoardEntityObject[];

      const existingObject = boardObjects.find(
        (bo: BoardEntityObject) => bo.worktree_id === worktree.worktree_id
      );

      if (existingObject) {
        this.log(chalk.yellow(`⚠ Worktree "${worktree.name}" already on board "${board.name}"`));
        await this.cleanupClient(client);
        return;
      }

      // Add worktree to board via board_objects
      await client.service('board-objects').create({
        board_id: board.board_id,
        worktree_id: worktree.worktree_id,
        position: { x: 100, y: 100 },
      });

      this.log(
        chalk.green(
          `✓ Added worktree "${worktree.name}" (containing session ${session.session_id.substring(0, 8)}) to board "${board.name}"`
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
