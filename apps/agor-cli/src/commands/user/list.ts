/**
 * `agor user list` - List all users
 */

import { shortId } from '@agor-live/client';
import chalk from 'chalk';
import Table from 'cli-table3';
import { BaseCommand } from '../../base-command';

export default class UserList extends BaseCommand {
  static description = 'List all users';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    const client = await this.connectToDaemon();
    try {
      const userList = await client.service('users').findAll();

      if (userList.length === 0) {
        this.log(chalk.yellow('No users found'));
        this.log('');
        this.log(chalk.gray('Create a user with: agor user create'));
        return;
      }

      // Create table
      const table = new Table({
        head: [
          chalk.cyan('ID'),
          chalk.cyan('Email'),
          chalk.cyan('Name'),
          chalk.cyan('Role'),
          chalk.cyan('Created'),
        ],
        style: {
          head: [],
          border: [],
        },
      });

      // Add rows
      for (const user of userList) {
        const idShort = shortId(user.user_id);
        const roleColor =
          user.role === 'superadmin'
            ? chalk.red
            : user.role === 'admin'
              ? chalk.yellow
              : user.role === 'member'
                ? chalk.green
                : chalk.gray;

        table.push([
          chalk.gray(idShort),
          user.email,
          user.name || chalk.gray('(not set)'),
          roleColor(user.role),
          new Date(user.created_at).toLocaleDateString(),
        ]);
      }

      this.log('');
      this.log(table.toString());
      this.log('');
      this.log(chalk.gray(`Total: ${userList.length} user${userList.length === 1 ? '' : 's'}`));
    } catch (error) {
      this.error(
        `${chalk.red('✗ Failed to list users')}\n${chalk.red(`  ${error instanceof Error ? error.message : String(error)}`)}`
      );
    } finally {
      await this.cleanupClient(client);
    }
  }
}
