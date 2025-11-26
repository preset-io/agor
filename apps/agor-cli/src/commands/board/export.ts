import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class BoardExport extends BaseCommand {
  static override description = 'Export a board to YAML or JSON';

  static override examples = [
    '<%= config.bin %> <%= command.id %> <board-id-or-slug> -o sprint-planning.yaml',
    '<%= config.bin %> <%= command.id %> <board-id-or-slug> -o sprint-planning.json --format json',
    '<%= config.bin %> <%= command.id %> <board-id-or-slug> # outputs to stdout',
  ];

  static override flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output file path',
    }),
    format: Flags.string({
      char: 'f',
      description: 'Export format (yaml or json)',
      options: ['yaml', 'json'],
      default: 'yaml',
    }),
  };

  static override args = {
    board: Args.string({
      description: 'Board ID or slug',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BoardExport);
    const { board } = args;
    const { output, format } = flags;

    const client = await this.connectToDaemon();

    try {
      const boardsService = client.service('boards');

      // Export based on format
      let content: string;
      if (format === 'json') {
        const blob = await boardsService.toBlob({ id: board });
        content = JSON.stringify(blob, null, 2);
      } else {
        content = await boardsService.toYaml({ id: board });
      }

      // Output to file or stdout
      if (output) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(output, content, 'utf-8');
        this.log(`Board exported to ${output}`);
      } else {
        this.log(content);
      }
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to export board: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await this.cleanupClient(client);
  }
}
