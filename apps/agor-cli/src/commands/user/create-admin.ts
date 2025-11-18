/**
 * `agor user create-admin` - Create default admin user (admin@agor.live / admin)
 */

import { join } from 'node:path';
import { getConfigPath } from '@agor/core/config';
import {
  createDatabase,
  createDefaultAdminUser,
  DEFAULT_ADMIN_USER,
  getUserByEmail,
  runMigrations,
} from '@agor/core/db';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class UserCreateAdmin extends Command {
  static description = 'Create default admin user (admin@agor.live / admin)';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    try {
      // Get database connection URL
      // Priority: DATABASE_URL env var > default SQLite file path
      let databaseUrl = process.env.DATABASE_URL;

      if (!databaseUrl) {
        // Default to SQLite if no DATABASE_URL specified
        const configPath = getConfigPath();
        const agorHome = join(configPath, '..');
        const dbPath = join(agorHome, 'agor.db');
        databaseUrl = `file:${dbPath}`;
      }

      // Connect to database (dialect is auto-detected from URL)
      const db = createDatabase({ url: databaseUrl });

      // Ensure migrations are run (idempotent, safe to run multiple times)
      // This is critical for Docker environments where init --skip-if-exists
      // might skip migrations if the directory already exists
      await runMigrations(db);

      // Check if admin user already exists
      const existingAdmin = await getUserByEmail(db, DEFAULT_ADMIN_USER.email);

      if (existingAdmin) {
        this.log(chalk.yellow('⚠ Admin user already exists'));
        this.log('');
        this.log(`  Email: ${chalk.cyan(DEFAULT_ADMIN_USER.email)}`);
        this.log(`  Name:  ${chalk.cyan(existingAdmin.name || '(not set)')}`);
        this.log(`  Role:  ${chalk.cyan(existingAdmin.role)}`);
        this.log(`  ID:    ${chalk.gray(existingAdmin.user_id.substring(0, 8))}`);
        this.log('');
        this.log(
          chalk.gray(
            `To reset password, use: agor user update ${DEFAULT_ADMIN_USER.email} --password newpassword`
          )
        );
        process.exit(0);
      }

      // Create default admin user
      this.log(chalk.gray('Creating admin user...'));
      const user = await createDefaultAdminUser(db);

      this.log(`${chalk.green('✓')} Admin user created successfully`);
      this.log('');
      this.log(`  Email:    ${chalk.cyan(DEFAULT_ADMIN_USER.email)}`);
      this.log(`  Password: ${chalk.cyan(DEFAULT_ADMIN_USER.password)}`);
      this.log(`  Name:     ${chalk.cyan(user.name)}`);
      this.log(`  Role:     ${chalk.cyan(user.role)}`);
      this.log(`  ID:       ${chalk.gray(user.user_id.substring(0, 8))}`);
      this.log('');
      this.log(chalk.yellow('⚠ SECURITY WARNING'));
      this.log(chalk.gray('  Change the password immediately using:'));
      this.log(
        chalk.gray(`  agor user update ${DEFAULT_ADMIN_USER.email} --password <new-password>`)
      );

      process.exit(0);
    } catch (error) {
      this.log('');
      this.log(chalk.red('✗ Failed to create admin user'));
      if (error instanceof Error) {
        this.log(chalk.red(`  ${error.message}`));
        if (error.stack) {
          this.log(chalk.gray(error.stack));
        }
        // Check for nested errors
        if ('cause' in error && error.cause) {
          this.log(chalk.red('  Caused by:'));
          if (error.cause instanceof Error) {
            this.log(chalk.red(`    ${error.cause.message}`));
          } else {
            this.log(chalk.red(`    ${String(error.cause)}`));
          }
        }
      } else {
        this.log(chalk.red(`  ${String(error)}`));
      }
      process.exit(1);
    }
  }
}
