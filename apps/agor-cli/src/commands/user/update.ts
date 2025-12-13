/**
 * `agor user update` - Update a user
 */

import type { User } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../../base-command';

export default class UserUpdate extends BaseCommand {
  static description = 'Update a user account';

  static examples = [
    '<%= config.bin %> <%= command.id %> test@example.com --name "New Name"',
    '<%= config.bin %> <%= command.id %> 0199d1bd --role member',
    '<%= config.bin %> <%= command.id %> test@example.com --password newpassword123',
  ];

  static args = {
    user: Args.string({
      description: 'User email or ID',
      required: true,
    }),
  };

  static flags = {
    email: Flags.string({
      description: 'New email address',
    }),
    name: Flags.string({
      description: 'New name',
    }),
    password: Flags.string({
      description: 'New password (will prompt if not provided)',
    }),
    role: Flags.string({
      description: 'New role',
      options: ['owner', 'admin', 'member', 'viewer'],
    }),
    'force-password-change': Flags.boolean({
      description: 'Force user to change password on next login',
      allowNo: true, // Allows --no-force-password-change to clear the flag
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(UserUpdate);
    const client = await this.connectToDaemon();

    try {
      // Find user by email or ID
      const usersService = client.service('users');
      const result = await usersService.find();
      const users = (Array.isArray(result) ? result : result.data) as User[];

      const user = users.find(
        (u) => u.email === args.user || u.user_id === args.user || u.user_id.startsWith(args.user)
      );

      if (!user) {
        await this.cleanupClient(client);
        this.error(
          `${chalk.red('✗ User not found')}\n${chalk.gray(`  No user matching: ${args.user}`)}`
        );
      }

      // If no flags provided, prompt for what to update
      if (
        !flags.email &&
        !flags.name &&
        !flags.password &&
        !flags.role &&
        flags['force-password-change'] === undefined
      ) {
        const { fields } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'fields',
            message: 'What would you like to update?',
            choices: [
              { name: 'Email', value: 'email' },
              { name: 'Name', value: 'name' },
              { name: 'Password', value: 'password' },
              { name: 'Role', value: 'role' },
            ],
          },
        ]);

        if (fields.length === 0) {
          this.log(chalk.gray('No changes selected'));
          await this.cleanupClient(client);
          return;
        }

        // Prompt for each selected field
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'email',
            message: 'New email:',
            when: fields.includes('email'),
            default: user.email,
            validate: (input: string) => {
              if (!input) return 'Email is required';
              if (!input.includes('@')) return 'Please enter a valid email';
              return true;
            },
          },
          {
            type: 'input',
            name: 'name',
            message: 'New name:',
            when: fields.includes('name'),
            default: user.name,
          },
          {
            type: 'password',
            name: 'password',
            message: 'New password:',
            when: fields.includes('password'),
            validate: (input: string) => {
              if (!input) return 'Password is required';
              if (input.length < 8) return 'Password must be at least 8 characters';
              return true;
            },
            mask: '*',
          },
          {
            type: 'list',
            name: 'role',
            message: 'New role:',
            when: fields.includes('role'),
            choices: ['owner', 'admin', 'member', 'viewer'],
            default: user.role,
          },
        ]);

        // Apply answers to flags
        if (answers.email) flags.email = answers.email;
        if (answers.name) flags.name = answers.name;
        if (answers.password) flags.password = answers.password;
        if (answers.role) flags.role = answers.role;
      }

      // Build update object
      const updates: Partial<User> & { password?: string; must_change_password?: boolean } = {};
      if (flags.email) updates.email = flags.email;
      if (flags.name) updates.name = flags.name;
      if (flags.password) updates.password = flags.password;
      if (flags.role) updates.role = flags.role as 'owner' | 'admin' | 'member' | 'viewer';
      if (flags['force-password-change'] !== undefined) {
        updates.must_change_password = flags['force-password-change'];
      }

      if (Object.keys(updates).length === 0) {
        this.log(chalk.gray('No changes to apply'));
        await this.cleanupClient(client);
        return;
      }

      // Update user
      this.log('');
      this.log(chalk.gray('Updating user...'));
      const updatedUser = await usersService.patch(user.user_id, updates);

      this.log(`${chalk.green('✓')} User updated successfully`);
      this.log('');
      this.log(`  Email: ${chalk.cyan(updatedUser.email)}`);
      this.log(`  Name:  ${chalk.cyan(updatedUser.name || '(not set)')}`);
      this.log(`  Role:  ${chalk.cyan(updatedUser.role)}`);
      this.log(`  ID:    ${chalk.gray(updatedUser.user_id.substring(0, 8))}`);
      if (updatedUser.must_change_password) {
        this.log(`  ${chalk.yellow('⚠')} User must change password on next login`);
      }

      await this.cleanupClient(client);
    } catch (error) {
      await this.cleanupClient(client);
      this.error(
        `${chalk.red('✗ Failed to update user')}\n${chalk.red(`  ${error instanceof Error ? error.message : String(error)}`)}`
      );
    }
  }
}
