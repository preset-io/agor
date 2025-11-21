/**
 * `agor user delete` - Delete a user
 */

import type { User } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../../base-command';

export default class UserDelete extends BaseCommand {
  static description = 'Delete a user account';

  static examples = [
    '<%= config.bin %> <%= command.id %> test@example.com',
    '<%= config.bin %> <%= command.id %> 0199d1bd',
    '<%= config.bin %> <%= command.id %> test@example.com --force',
  ];

  static args = {
    user: Args.string({
      description: 'User email or ID',
      required: true,
    }),
  };

  static flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(UserDelete);
    const client = await this.connectToDaemon();

    try {
      // Find user by email or ID
      const usersService = client.service('users');
      const result = await usersService.find();
      const users = (Array.isArray(result) ? result : result.data) as User[];

      const user = users.find(
        u => u.email === args.user || u.user_id === args.user || u.user_id.startsWith(args.user)
      );

      if (!user) {
        await this.cleanupClient(client);
        this.error(
          `${chalk.red('✗ User not found')}\n${chalk.gray(`  No user matching: ${args.user}`)}`
        );
      }

      // Confirm deletion (unless --force)
      if (!flags.force) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Delete user ${chalk.cyan(user.email)} (${chalk.gray(user.user_id.substring(0, 8))})`,
            default: false,
          },
        ]);

        if (!confirm) {
          this.log(chalk.gray('Cancelled'));
          await this.cleanupClient(client);
          return;
        }
      }

      // Delete user
      await usersService.remove(user.user_id);

      this.log(`${chalk.green('✓')} User deleted successfully`);
      this.log('');
      this.log(`  Email: ${chalk.cyan(user.email)}`);
      this.log(`  ID:    ${chalk.gray(user.user_id.substring(0, 8))}`);

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `${chalk.red('✗ Failed to delete user')}\n${chalk.red(`  ${error instanceof Error ? error.message : String(error)}`)}`
      );
    }
  }
}
