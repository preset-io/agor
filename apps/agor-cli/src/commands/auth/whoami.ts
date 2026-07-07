/**
 * `agor whoami` - Show current authenticated user
 *
 * Displays information about the currently authenticated user
 */

import { Command } from '@oclif/core';
import chalk from 'chalk';
import { loadToken } from '../../lib/auth';

export default class Whoami extends Command {
  static description = 'Show current authenticated user';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    await this.parse(Whoami);

    const storedAuth = await loadToken();

    if (!storedAuth) {
      this.log(chalk.dim('Not currently logged in'));
      this.log('');
      this.log(chalk.dim('To login:'), chalk.cyan('agor login'));
      this.log('');
      return;
    }

    this.log('');
    this.log(chalk.green('✓ Authenticated'));
    this.log('');
    this.log(chalk.dim('User ID:'), chalk.cyan(storedAuth.user.user_id));
    this.log(chalk.dim('Email:'), chalk.cyan(storedAuth.user.email));
    if (storedAuth.user.name) {
      this.log(chalk.dim('Name:'), storedAuth.user.name);
    }
    this.log(chalk.dim('Role:'), storedAuth.user.role);
    this.log('');

    // Show token expiry
    const expiresIn = storedAuth.expiresAt - Date.now();
    const daysLeft = Math.floor(expiresIn / (24 * 60 * 60 * 1000));
    const hoursLeft = Math.floor((expiresIn % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

    if (expiresIn > 0) {
      this.log(chalk.dim('Token expires in:'), `${daysLeft}d ${hoursLeft}h`);
    } else {
      this.log(chalk.red('Token expired'), chalk.dim('- please login again'));
    }
    this.log('');
  }
}
