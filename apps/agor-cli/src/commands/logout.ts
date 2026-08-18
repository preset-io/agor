/**
 * `agor logout` - Clear stored authentication token
 *
 * Removes JWT token from disk
 */

import { Command } from '@oclif/core';
import chalk from 'chalk';
import { clearToken, loadToken } from '../lib/auth';

export default class Logout extends Command {
  static description = 'Clear the current deployment connection';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    // Check if user is logged in
    const storedAuth = await loadToken();

    if (!storedAuth) {
      this.log(chalk.dim('Not currently logged in'));
      return;
    }

    // Clear token
    await clearToken();

    this.log('');
    this.log(chalk.green('✓ Logged out successfully'));
    this.log('');
    this.log(chalk.dim('Token removed from ~/.agor/cli-token'));
    this.log('');
  }
}
