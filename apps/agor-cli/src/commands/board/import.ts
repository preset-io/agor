import type { Board } from '@agor/core/types';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class BoardImport extends BaseCommand {
  static override description = 'Import a board from YAML or JSON file';

  static override examples = [
    '<%= config.bin %> <%= command.id %> sprint-planning.yaml',
    '<%= config.bin %> <%= command.id %> sprint-planning.json',
    'cat sprint-planning.yaml | <%= config.bin %> <%= command.id %> # from stdin',
  ];

  static override args = {
    file: Args.string({
      description: 'Path to YAML or JSON file (omit to read from stdin)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(BoardImport);
    const { file } = args;

    const client = await this.connectToDaemon();

    try {
      const boardsService = client.service('boards');

      // Read content from file or stdin
      let content: string;
      if (file) {
        const fs = await import('node:fs/promises');
        content = await fs.readFile(file, 'utf-8');
      } else {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        content = Buffer.concat(chunks).toString('utf-8');
      }

      // Import based on content (JSON or YAML)
      let board: Board;
      try {
        // Try parsing as JSON first
        const blob = JSON.parse(content);
        board = await boardsService.fromBlob(blob);
      } catch {
        // If JSON parse fails, treat as YAML
        board = await boardsService.fromYaml({ yaml: content });
      }

      this.log(`Board imported: ${board.name} (${board.board_id})`);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to import board: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await this.cleanupClient(client);
  }
}
