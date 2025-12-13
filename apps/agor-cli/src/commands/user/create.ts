/**
 * `agor user create` - Create a new user
 */

import type { CreateUserInput, UserRole } from '@agor/core/types';
import { Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../../base-command';

export default class UserCreate extends BaseCommand {
  static description = 'Create a new user account';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --email admin@localhost --name Admin',
    '<%= config.bin %> <%= command.id %> --email max@example.com --role admin',
  ];

  static flags = {
    email: Flags.string({
      description: 'User email address',
      required: false,
    }),
    name: Flags.string({
      description: 'User display name',
      required: false,
    }),
    password: Flags.string({
      description: 'User password (will prompt if not provided)',
      required: false,
    }),
    role: Flags.string({
      description: 'User role',
      options: [/* 'owner', */ 'admin', 'member', 'viewer'], // owner role unused
      default: 'admin',
    }),
    'force-password-change': Flags.boolean({
      description: 'Force user to change password on first login',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(UserCreate);
    const client = await this.connectToDaemon();

    try {
      // Prompt for missing fields
      let enteredPassword = flags.password;
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'email',
          message: 'Email address:',
          when: !flags.email,
          validate: (input: string) => {
            if (!input) return 'Email is required';
            if (!input.includes('@')) return 'Please enter a valid email';
            return true;
          },
        },
        {
          type: 'input',
          name: 'name',
          message: 'Name (optional):',
          when: !flags.name,
        },
        {
          type: 'password',
          name: 'password',
          message: 'Password:',
          when: !flags.password,
          validate: (input: string) => {
            if (!input) return 'Password is required';
            if (input.length < 8) return 'Password must be at least 8 characters';
            enteredPassword = input; // Store for confirmation validation
            return true;
          },
          mask: '*',
        },
        {
          type: 'password',
          name: 'confirmPassword',
          message: 'Confirm password:',
          when: !flags.password,
          validate: (input: string) => {
            if (input !== enteredPassword) {
              return 'Passwords do not match';
            }
            return true;
          },
          mask: '*',
        },
      ]);

      const email = flags.email || answers.email;
      const name = flags.name || answers.name;
      const password = flags.password || answers.password;

      // Create user
      this.log('');
      this.log(chalk.gray('Creating user...'));
      const userData: CreateUserInput = {
        email,
        password,
        name: name || undefined,
        role: flags.role as UserRole,
        must_change_password: flags['force-password-change'],
      };
      const user = await client.service('users').create(userData);

      this.log(`${chalk.green('✓')} User created successfully`);
      this.log('');
      this.log(`  Email: ${chalk.cyan(user.email)}`);
      this.log(`  Name:  ${chalk.cyan(user.name || '(not set)')}`);
      this.log(`  Role:  ${chalk.cyan(user.role)}`);
      this.log(`  ID:    ${chalk.gray(user.user_id.substring(0, 8))}`);
      if (user.must_change_password) {
        this.log(`  ${chalk.yellow('⚠')} User must change password on first login`);
      }
      this.log('');
      this.log(chalk.gray('Next steps:'));
      this.log(chalk.gray('  1. Start daemon: pnpm --filter @agor/daemon dev'));
      this.log(chalk.gray('  2. Login via UI: http://localhost:5173'));

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      const errorMessage =
        error instanceof Error
          ? error.message.includes('already exists')
            ? 'User with this email already exists'
            : error.message
          : String(error);
      this.error(`${chalk.red('✗ Failed to create user')}\n${chalk.red(`  ${errorMessage}`)}`);
    }
  }
}
