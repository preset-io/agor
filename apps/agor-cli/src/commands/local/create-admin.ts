/**
 * `agor local create-admin` - Create bootstrap admin user
 */

import { join } from 'node:path';
import { getConfigPath, loadConfig, resolveMultiTenancyConfig } from '@agor/core/config';
import {
  assertDevelopmentDefaultAdminEnvironment,
  assertUsableBootstrapAdminPassword,
  createDatabase,
  createDefaultAdminUser,
  createDevelopmentDefaultAdminUser,
  createTenantScopedDatabaseProxy,
  DEVELOPMENT_DEFAULT_ADMIN_USER,
  getUserByEmail,
  runMigrations,
  runWithTenantDatabaseScope,
  sanitizeDbError,
  shortId,
} from '@agor/core/db';
import type { User } from '@agor/core/types';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';

export default class LocalCreateAdmin extends Command {
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
      description:
        'Admin password. If omitted, uses AGOR_ADMIN_PASSWORD before prompting interactively.',
      required: false,
    }),
    name: Flags.string({
      description: 'Admin display name',
      default: DEVELOPMENT_DEFAULT_ADMIN_USER.name,
    }),
    'unix-username': Flags.string({
      description: 'Execution home key for shell access',
      default: DEVELOPMENT_DEFAULT_ADMIN_USER.unix_username,
    }),
    'dev-default': Flags.boolean({
      description:
        'Development/test only: exact admin default; requires AGOR_ADMIN_PASSWORD=admin, AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN=true, and development/test NODE_ENV.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(LocalCreateAdmin);

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

        let password = resolveAdminPassword(flags.password);
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
        let user: User;
        if (flags['dev-default']) {
          assertDevelopmentDefaultAdminCliRequest({
            email: flags.email,
            name: flags.name,
            unixUsername: flags['unix-username'],
            password: flags.password,
          });
          user = await createDevelopmentDefaultAdminUser(db);
        } else {
          user = await createDefaultAdminUser(db, {
            email: flags.email,
            password,
            name: flags.name,
            unix_username: flags['unix-username'],
          });
        }

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
      const safeError = sanitizeDbError(error);
      this.log(chalk.red(`  ${safeError.message}`));
      process.exit(1);
    }
  }
}

/** Validate the CLI-specific shape, then delegate environment policy to core. */
export function assertDevelopmentDefaultAdminCliRequest(
  request: { email: string; name: string; unixUsername: string; password?: string },
  env: NodeJS.ProcessEnv = process.env
): void {
  if (
    request.email !== DEVELOPMENT_DEFAULT_ADMIN_USER.email ||
    request.name !== DEVELOPMENT_DEFAULT_ADMIN_USER.name ||
    request.unixUsername !== DEVELOPMENT_DEFAULT_ADMIN_USER.unix_username ||
    request.password !== undefined
  ) {
    throw new Error(
      '--dev-default is restricted to the exact admin@agor.live / admin development identity'
    );
  }
  assertDevelopmentDefaultAdminEnvironment(env);
}

/** Resolve a bootstrap secret without requiring it in process arguments. */
export function resolveAdminPassword(
  flagPassword: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return flagPassword ?? env.AGOR_ADMIN_PASSWORD;
}
