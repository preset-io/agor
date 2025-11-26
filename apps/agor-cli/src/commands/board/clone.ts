import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class BoardClone extends BaseCommand {
  static override description = 'Clone an existing board with a new name';

  static override examples = [
    '<%= config.bin %> <%= command.id %> <board-id-or-slug> "Sprint 43 Planning"',
    '<%= config.bin %> <%= command.id %> sprint-42 "Sprint 42 (Copy)"',
  ];

  static override args = {
    board: Args.string({
      description: 'Board ID or slug to clone',
      required: true,
    }),
    name: Args.string({
      description: 'Name for the cloned board',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(BoardClone);
    const { board, name } = args;

    const client = await this.connectToDaemon();

    try {
      const boardsService = client.service('boards');

      const clonedBoard = await boardsService.clone({ id: board, name });

      this.log(`Board cloned: ${clonedBoard.name} (${clonedBoard.board_id})`);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to clone board: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await this.cleanupClient(client);
  }
}
