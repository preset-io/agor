/**
 * `agor login` - Authenticate with daemon
 *
 * Prompts for email/password and stores JWT token for future CLI commands
 */

import { createRestClient, isDaemonRunning } from '@agor-live/client';
import { getDaemonUrl } from '@agor-live/client/config';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { saveToken } from '../../lib/auth';

export default class Login extends Command {
  static description = 'Authenticate with Agor daemon';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --email user@example.com',
  ];

  static flags = {
    email: Flags.string({
      char: 'e',
      description: 'Email address',
    }),
    password: Flags.string({
      char: 'p',
      description: 'Password (will prompt if not provided)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);

    // Get daemon URL
    const daemonUrl = await getDaemonUrl();

    // Check if daemon is running
    const running = await isDaemonRunning(daemonUrl);
    if (!running) {
      this.error(
        chalk.red('✗ Daemon not running') +
          '\n\n' +
          chalk.bold('To start the daemon:') +
          '\n  ' +
          chalk.cyan('cd apps/agor-daemon && pnpm dev')
      );
    }

    // Get credentials (prompt if not provided)
    let email = flags.email;
    let password = flags.password;

    if (!email || !password) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'email',
          message: 'Email',
          default: email,
          validate: (input: string) => {
            if (!input || !input.includes('@')) {
              return 'Please enter a valid email address';
            }
            return true;
          },
        },
        {
          type: 'password',
          name: 'password',
          message: 'Password',
          mask: '*',
          validate: (input: string) => {
            if (!input) {
              return 'Password is required';
            }
            return true;
          },
        },
      ]);

      email = answers.email;
      password = answers.password;
    }

    // Create REST-only client (prevents hanging)
    const client = await createRestClient(daemonUrl);

    try {
      this.log(chalk.dim('Authenticating...'));

      // Authenticate with local strategy
      const authResult = await client.authenticate({
        strategy: 'local',
        email,
        password,
      });

      if (!authResult.accessToken || !authResult.user) {
        this.error('Authentication failed - no token returned');
      }

      // Calculate token expiry (7 days from now, matching daemon config)
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

      // Save token to disk
      await saveToken({
        accessToken: authResult.accessToken,
        user: {
          user_id: authResult.user.user_id,
          email: authResult.user.email,
          // biome-ignore lint/suspicious/noExplicitAny: AuthenticatedUser type doesn't include name, but it's returned
          name: (authResult.user as any).name,
          role: authResult.user.role || 'viewer',
        },
        expiresAt,
      });

      this.log('');
      this.log(chalk.green('✓ Logged in successfully'));
      this.log('');
      this.log(chalk.dim('User:'), chalk.cyan(authResult.user.email));
      // biome-ignore lint/suspicious/noExplicitAny: AuthenticatedUser type doesn't include name, but it's returned
      const userName = (authResult.user as any).name;
      if (userName) {
        this.log(chalk.dim('Name:'), userName);
      }
      this.log(chalk.dim('Role:'), authResult.user.role || 'viewer');
      this.log('');
      this.log(chalk.dim('Token saved to ~/.agor/cli-token'));
      this.log(chalk.dim('Token expires in 7 days'));
      this.log('');

      // Cleanup socket connection
      client.io.io.opts.reconnection = false;
      client.io.removeAllListeners();
      client.io.close();
      process.exit(0);
    } catch (error) {
      // Cleanup socket connection
      client.io.io.opts.reconnection = false;
      client.io.removeAllListeners();
      client.io.close();

      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('Invalid login') || errorMessage.includes('NotFound')) {
        this.error(chalk.red('✗ Invalid email or password'));
      }

      this.error(chalk.red(`✗ Authentication failed: ${errorMessage}`));
    }
  }
}
