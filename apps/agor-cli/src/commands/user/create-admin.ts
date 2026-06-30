/**
 * `agor user create-admin` - Create bootstrap admin user
 */

import { join } from 'node:path';
import { getConfigPath, loadConfig, resolveMultiTenancyConfig } from '@agor/core/config';
import {
  assertUsableBootstrapAdminPassword,
  createDatabase,
  createDefaultAdminUser,
  createTenantScopedDatabaseProxy,
  DEVELOPMENT_DEFAULT_ADMIN_USER,
  getUserByEmail,
  runMigrations,
  runWithTenantDatabaseScope,
  shortId,
} from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';

export default class UserCreateAdmin extends Command {
  static description = 'Create a bootstrap superadmin user';

  static examples = [
    '<%= config.bin %> <%= command.id %> --password <password>',
    '<%= config.bin %> <%= command.id %> --dev-default',
  ];

  static flags = {
    email: Flags.string({
      description: 'Admin email address',
      default: DEVELOPMENT_DEFAULT_ADMIN_USER.email,
    }),
    password: Flags.string({
      description: 'Admin password. If omitted, prompts interactively.',
      required: false,
    }),
    name: Flags.string({
      description: 'Admin display name',
      default: DEVELOPMENT_DEFAULT_ADMIN_USER.name,
    }),
    'unix-username': Flags.string({
      description: 'Unix username for shell access',
      default: DEVELOPMENT_DEFAULT_ADMIN_USER.unix_username,
    }),
    'dev-default': Flags.boolean({
      description:
        'Development/test only: use admin@agor.live / admin. Refused when NODE_ENV=production.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(UserCreateAdmin);

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
      const db = createTenantScopedDatabaseProxy(createDatabase({ url: databaseUrl }));

      // Ensure migrations are run (idempotent, safe to run multiple times)
      // This is critical for Docker environments where init --skip-if-exists
      // might skip migrations if the directory already exists
      await runMigrations(db);

      const config = await loadConfig();
      const multiTenancy = resolveMultiTenancyConfig(config);
      const tenantId = multiTenancy.mode === 'static' ? multiTenancy.static_tenant_id : undefined;

      await runWithTenantDatabaseScope(db, tenantId, async () => {
        // Check if admin user already exists in the active tenant.
        const existingAdmin = await getUserByEmail(db, flags.email);

        if (existingAdmin) {
          this.log(chalk.yellow('⚠ Admin user already exists'));
          this.log('');
          this.log(`  Email: ${chalk.cyan(flags.email)}`);
          if (tenantId) this.log(`  Tenant: ${chalk.cyan(tenantId)}`);
          this.log(`  Name:  ${chalk.cyan(existingAdmin.name || '(not set)')}`);
          this.log(`  Role:  ${chalk.cyan(existingAdmin.role)}`);
          this.log(`  ID:    ${chalk.gray(shortId(existingAdmin.user_id))}`);
          this.log('');
          this.log(
            chalk.gray(
              `To reset password, use: agor user update ${flags.email} --password newpassword`
            )
          );
          process.exit(0);
        }

        let password = flags.password;
        if (!password && !flags['dev-default']) {
          const passwordAnswer = await inquirer.prompt<{ password: string }>([
            {
              type: 'password' as const,
              name: 'password',
              message: 'Admin password:',
              validate: (input: string) => {
                try {
                  if (!input) return 'Password is required';
                  assertUsableBootstrapAdminPassword(input, 'Admin password');
                } catch (error) {
                  return error instanceof Error ? error.message : String(error);
                }
                return true;
              },
              mask: '*',
            },
          ]);
          await inquirer.prompt<{ confirmPassword: string }>([
            {
              type: 'password' as const,
              name: 'confirmPassword',
              message: 'Confirm password:',
              validate: (input: string) => {
                if (input !== passwordAnswer.password) return 'Passwords do not match';
                return true;
              },
              mask: '*',
            },
          ]);
          password = passwordAnswer.password;
        }

        // Create admin user
        this.log(chalk.gray('Creating admin user...'));
        const user = await createDefaultAdminUser(db, {
          email: flags.email,
          password,
          name: flags.name,
          unix_username: flags['unix-username'],
          allowDevelopmentDefault: flags['dev-default'],
        });

        this.log(`${chalk.green('✓')} Admin user created successfully`);
        this.log('');
        this.log(`  Email:    ${chalk.cyan(flags.email)}`);
        if (tenantId) this.log(`  Tenant:   ${chalk.cyan(tenantId)}`);
        if (flags['dev-default']) {
          this.log(`  Password: ${chalk.cyan(DEVELOPMENT_DEFAULT_ADMIN_USER.password)}`);
          this.log(chalk.yellow('  ⚠ Development-only default credential enabled'));
        } else {
          this.log('  Password: (provided; not printed)');
        }
        this.log(`  Name:     ${chalk.cyan(user.name)}`);
        this.log(`  Role:     ${chalk.cyan(user.role)}`);
        this.log(`  ID:       ${chalk.gray(shortId(user.user_id))}`);
        if (user.must_change_password) {
          this.log(`  ${chalk.yellow('⚠')} User must change password on first login`);
        }
      });

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
