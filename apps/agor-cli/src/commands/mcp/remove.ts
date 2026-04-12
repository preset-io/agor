/**
 * Remove an MCP server
 */

import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class McpRemove extends BaseCommand {
  static override description = 'Remove an MCP server';

  static override examples = [
    '<%= config.bin %> <%= command.id %> 0199b856',
    '<%= config.bin %> <%= command.id %> filesystem --force',
  ];

  static override args = {
    id: Args.string({
      description: 'MCP server ID or name',
      required: true,
    }),
  };

  static override flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(McpRemove);

    const client = await this.connectToDaemon();

    try {
      // Try to find the server first
      let serverId = args.id;

      // If it looks like a name (not a UUID), try to find by name
      if (!args.id.match(/^[0-9a-f]{8}/i)) {
        const servers = await client.service('mcp-servers').findAll({
          query: { $limit: 100 },
        });
        const server = servers.find((s: { name: string }) => s.name === args.id);

        if (!server) {
          await this.cleanupClient(client);
          this.error(`MCP server not found: ${args.id}`);
        }

        serverId = server.mcp_server_id;
      }

      // Confirm deletion unless --force is used
      if (!flags.force) {
        this.log('');
        this.log(chalk.yellow(`⚠️  This will permanently remove the MCP server: ${args.id}`));
        this.log('');

        // Simple confirmation (oclif doesn't have built-in prompts, so we skip for now)
        // In production, you'd use a prompt library like inquirer
        this.log(chalk.gray('Use --force to skip this confirmation'));
        this.log('');
        await this.cleanupClient(client);
        return;
      }

      // Delete the server
      await client.service('mcp-servers').remove(serverId);

      this.log('');
      this.log(`${chalk.green('✓')} MCP server removed: ${args.id}`);
      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to remove MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
