/**
 * `agor mcp add` - Add a new MCP server
 */

import type { MCPServer } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class McpAdd extends BaseCommand {
  static description = 'Add a new MCP server';

  static examples = [
    '<%= config.bin %> <%= command.id %> filesystem --command npx --args "@modelcontextprotocol/server-filesystem,/path/to/allowed"',
    '<%= config.bin %> <%= command.id %> sentry --transport http --url https://mcp.sentry.dev/mcp',
    '<%= config.bin %> <%= command.id %> custom-tool --command node --args "dist/server.js" --scope session --session-id 0199b856',
  ];

  static args = {
    name: Args.string({
      description: 'MCP server name (e.g., filesystem, sentry, custom-tool)',
      required: true,
    }),
  };

  static flags = {
    transport: Flags.string({
      char: 't',
      description: 'Transport type',
      options: ['stdio', 'http', 'sse'],
      default: 'stdio',
    }),
    command: Flags.string({
      char: 'c',
      description: 'Command to run (for stdio transport)',
    }),
    args: Flags.string({
      char: 'a',
      description: 'Command arguments (comma-separated)',
    }),
    url: Flags.string({
      char: 'u',
      description: 'Server URL (for http/sse transport)',
    }),
    scope: Flags.string({
      char: 's',
      description: 'Server scope',
      options: ['global', 'team', 'repo', 'session'],
      default: 'global',
    }),
    'session-id': Flags.string({
      description: 'Session ID (required if scope=session)',
    }),
    'repo-id': Flags.string({
      description: 'Repo ID (required if scope=repo)',
    }),
    'display-name': Flags.string({
      char: 'd',
      description: 'Display name for the server',
    }),
    description: Flags.string({
      description: 'Server description',
    }),
    enabled: Flags.boolean({
      description: 'Enable server immediately',
      default: true,
    }),
    env: Flags.string({
      char: 'e',
      description: 'Environment variables (key=value pairs, comma-separated)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(McpAdd);

    // Validate transport-specific flags
    if (flags.transport === 'stdio' && !flags.command) {
      this.error('--command is required for stdio transport');
    }

    if ((flags.transport === 'http' || flags.transport === 'sse') && !flags.url) {
      this.error('--url is required for http/sse transport');
    }

    // Validate scope-specific flags
    if (flags.scope === 'session' && !flags['session-id']) {
      this.error('--session-id is required when scope=session');
    }

    if (flags.scope === 'repo' && !flags['repo-id']) {
      this.error('--repo-id is required when scope=repo');
    }

    const client = await this.connectToDaemon();

    try {
      this.log('');
      this.log(chalk.bold(`Adding MCP server ${chalk.cyan(args.name)}...`));

      // Build request data
      const data: Record<string, unknown> = {
        name: args.name,
        display_name: flags['display-name'],
        description: flags.description,
        transport: flags.transport,
        scope: flags.scope,
        enabled: flags.enabled,
        source: 'user',
      };

      // Add transport-specific config
      if (flags.command) data.command = flags.command;
      if (flags.args) data.args = flags.args.split(',').map(arg => arg.trim());
      if (flags.url) data.url = flags.url;

      // Add environment variables
      if (flags.env) {
        const envPairs = flags.env.split(',').map(pair => pair.trim());
        const envObject: Record<string, string> = {};
        for (const pair of envPairs) {
          const [key, value] = pair.split('=');
          if (key && value) {
            envObject[key.trim()] = value.trim();
          }
        }
        if (Object.keys(envObject).length > 0) {
          data.env = envObject;
        }
      }

      // Add scope-specific IDs
      if (flags['session-id']) data.session_id = flags['session-id'];
      if (flags['repo-id']) data.repo_id = flags['repo-id'];

      // Call daemon API
      const server = (await client.service('mcp-servers').create(data)) as MCPServer;

      this.log(`${chalk.green('✓')} MCP server added`);
      this.log('');
      this.log(chalk.bold('Server Details:'));
      this.log(`  ${chalk.cyan('ID')}: ${String(server.mcp_server_id).substring(0, 8)}`);
      this.log(`  ${chalk.cyan('Name')}: ${server.name}`);
      this.log(`  ${chalk.cyan('Transport')}: ${server.transport}`);
      this.log(`  ${chalk.cyan('Scope')}: ${server.scope}`);
      this.log(
        `  ${chalk.cyan('Enabled')}: ${server.enabled ? chalk.green('✓') : chalk.gray('✗')}`
      );

      if (server.command) {
        this.log(`  ${chalk.cyan('Command')}: ${server.command}`);
      }
      if (server.args) {
        this.log(`  ${chalk.cyan('Args')}: ${server.args.join(', ')}`);
      }
      if (server.url) {
        this.log(`  ${chalk.cyan('URL')}: ${server.url}`);
      }
      if (server.env) {
        const envKeys = Object.keys(server.env);
        this.log(`  ${chalk.cyan('Environment')}: ${envKeys.join(', ')}`);
      }

      this.log('');

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `Failed to add MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
