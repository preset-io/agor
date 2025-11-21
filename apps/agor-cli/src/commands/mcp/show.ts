/**
 * Show details for an MCP server
 */

import type { MCPServer } from '@agor/core/types';
import { Args } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class McpShow extends BaseCommand {
  static override description = 'Show MCP server details';

  static override examples = [
    '<%= config.bin %> <%= command.id %> 0199b856',
    '<%= config.bin %> <%= command.id %> filesystem',
  ];

  static override args = {
    id: Args.string({
      description: 'MCP server ID or name',
      required: true,
    }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(McpShow);
    const client = await this.connectToDaemon();

    try {
      // Try to fetch by ID first
      let server: MCPServer | null = null;

      try {
        server = (await client.service('mcp-servers').get(args.id)) as MCPServer;
      } catch {
        // If not found by ID, try to find by name
        const result = await client.service('mcp-servers').find({
          query: { $limit: 1 },
        });
        const servers = (Array.isArray(result) ? result : result.data) as MCPServer[];
        server = servers.find(s => s.name === args.id) || null;
      }

      if (!server) {
        await this.cleanupClient(client);
        this.error(`MCP server not found: ${args.id}`);
      }

      // Display server details
      this.log('');
      this.log(chalk.bold(chalk.cyan('MCP Server Details')));
      this.log('');
      this.log(`${chalk.cyan('ID')}: ${server.mcp_server_id}`);
      this.log(`${chalk.cyan('Short ID')}: ${String(server.mcp_server_id).substring(0, 8)}`);
      this.log(`${chalk.cyan('Name')}: ${server.name}`);

      if (server.display_name) {
        this.log(`${chalk.cyan('Display Name')}: ${server.display_name}`);
      }

      if (server.description) {
        this.log(`${chalk.cyan('Description')}: ${server.description}`);
      }

      this.log('');
      this.log(chalk.bold('Configuration'));
      this.log(`${chalk.cyan('Transport')}: ${server.transport}`);
      this.log(`${chalk.cyan('Scope')}: ${server.scope}`);
      this.log(`${chalk.cyan('Source')}: ${server.source}`);
      this.log(
        `${chalk.cyan('Enabled')}: ${server.enabled ? chalk.green('✓ Yes') : chalk.gray('✗ No')}`
      );

      if (server.command) {
        this.log(`${chalk.cyan('Command')}: ${server.command}`);
      }

      if (server.args && server.args.length > 0) {
        this.log(`${chalk.cyan('Arguments')}:`);
        for (const arg of server.args) {
          this.log(`  - ${arg}`);
        }
      }

      if (server.url) {
        this.log(`${chalk.cyan('URL')}: ${server.url}`);
      }

      if (server.env && Object.keys(server.env).length > 0) {
        this.log(`${chalk.cyan('Environment Variables')}:`);
        for (const [key, value] of Object.entries(server.env)) {
          this.log(`  ${key}=${value}`);
        }
      }

      // Show capabilities if available
      if (server.tools || server.resources || server.prompts) {
        this.log('');
        this.log(chalk.bold('Capabilities'));

        if (server.tools && server.tools.length > 0) {
          this.log(`${chalk.cyan('Tools')}: ${server.tools.length}`);
          for (const tool of server.tools.slice(0, 5)) {
            this.log(`  - ${tool.name}: ${tool.description}`);
          }
          if (server.tools.length > 5) {
            this.log(chalk.gray(`  ... and ${server.tools.length - 5} more`));
          }
        }

        if (server.resources && server.resources.length > 0) {
          this.log(`${chalk.cyan('Resources')}: ${server.resources.length}`);
          for (const resource of server.resources.slice(0, 5)) {
            this.log(`  - ${resource.name} (${resource.uri})`);
          }
          if (server.resources.length > 5) {
            this.log(chalk.gray(`  ... and ${server.resources.length - 5} more`));
          }
        }

        if (server.prompts && server.prompts.length > 0) {
          this.log(`${chalk.cyan('Prompts')}: ${server.prompts.length}`);
          for (const prompt of server.prompts.slice(0, 5)) {
            this.log(`  - /${prompt.name}: ${prompt.description}`);
          }
          if (server.prompts.length > 5) {
            this.log(chalk.gray(`  ... and ${server.prompts.length - 5} more`));
          }
        }
      }

      this.log('');
      this.log(chalk.gray(`Created: ${new Date(server.created_at).toLocaleString()}`));
      if (server.updated_at) {
        this.log(chalk.gray(`Updated: ${new Date(server.updated_at).toLocaleString()}`));
      }
      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to fetch MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
