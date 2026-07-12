/**
 * `agor init` - Initialize Agor environment
 *
 * Creates directory structure and initializes database.
 * Safe to run multiple times (idempotent).
 */

import { access, constants, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, setConfigValue } from '@agor/core/config';
import {
  createDatabase,
  createUser,
  DEVELOPMENT_DEFAULT_ADMIN_USER,
  runMigrations,
  seedInitialData,
} from '@agor/core/db';
import {
  AGOR_TELEMETRY_DOCS_URL,
  createOpenSourceTelemetryLogger,
  generateTelemetryInstanceId,
  isTelemetryFullyDisabledByEnv,
  loadOpenSourceTelemetryAgorVersion,
  pruneDefaultOpenSourceTelemetryDestination,
} from '@agor/core/telemetry';
import { isDaemonRunning } from '@agor-live/client';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';

export default class Init extends Command {
  static description = 'Initialize Agor environment (creates ~/.agor/ and database)';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --local',
  ];

  static flags = {
    local: Flags.boolean({
      char: 'l',
      description: 'Initialize local .agor/ directory in current working directory',
      default: false,
    }),
    force: Flags.boolean({
      char: 'f',
      description:
        'Force re-initialization without prompts (deletes database, repos, and branches)',
      default: false,
    }),
    'skip-if-exists': Flags.boolean({
      description:
        'Skip initialization if .agor/ directory already exists (idempotent, safe for Docker)',
      default: false,
    }),
    'daemon-port': Flags.integer({
      description: 'Daemon port (reads from DAEMON_PORT env var if not specified)',
      required: false,
    }),
    'daemon-host': Flags.string({
      description: 'Daemon host (default: localhost)',
      required: false,
    }),
    'set-config': Flags.boolean({
      description: 'Set daemon config values even if .agor already exists (for Docker/deployment)',
      default: false,
    }),
    'instance-label': Flags.string({
      description: 'Instance label for deployment identification (e.g., "staging", "prod-us-east")',
      required: false,
    }),
  };

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private expandHome(path: string): string {
    if (path.startsWith('~/')) {
      return join(homedir(), path.slice(2));
    }
    return path;
  }

  /**
   * Count rows in database tables for display
   */
  private async getDbStats(dbPath: string): Promise<{
    sessions: number;
    tasks: number;
    messages: number;
    repos: number;
  } | null> {
    try {
      const { createDatabase, select, sessions, tasks, messages, repos } = await import(
        '@agor/core/db'
      );
      const db = createDatabase({ url: `file:${dbPath}`, dialect: 'sqlite' });

      // Count rows by selecting all and measuring length
      const sessionRows = await select(db).from(sessions).all();
      const taskRows = await select(db).from(tasks).all();
      const messageRows = await select(db).from(messages).all();
      const repoRows = await select(db).from(repos).all();

      return {
        sessions: sessionRows.length,
        tasks: taskRows.length,
        messages: messageRows.length,
        repos: repoRows.length,
      };
    } catch {
      return null;
    }
  }

  /**
   * List directories in a path (repos, branches)
   */
  private async listDirs(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Detect if running in dev mode (from source) vs agor-live (npm package)
   *
   * Dev mode = running from agor monorepo source
   * Agor-live mode = running from npm package (globally installed or in node_modules)
   */
  private async isDevMode(): Promise<boolean> {
    // Get the directory where this file is running from
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // If running from node_modules/agor-live, it's definitely the npm package
    // (more specific than just checking for "node_modules" which could catch dev mode too)
    if (
      __dirname.includes('node_modules/agor-live') ||
      __dirname.includes('node_modules\\agor-live')
    ) {
      return false;
    }

    // Check if we're in the agor monorepo by looking for packages/core in cwd
    // This is the most reliable way to detect dev mode regardless of compilation state
    const corePackagePath = join(process.cwd(), 'packages', 'core');
    const isInMonorepo = await this.pathExists(corePackagePath);

    // If we're in the monorepo, it's dev mode
    // Otherwise (could be anywhere when running agor-live), it's the npm package
    return isInMonorepo;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Init);

    this.log('✨ Initializing Agor...\n');

    // Determine base directory early
    const baseDir = flags.local ? join(process.cwd(), '.agor') : join(homedir(), '.agor');

    // If --skip-if-exists and directory already exists, handle config and exit
    if (flags['skip-if-exists'] && (await this.pathExists(baseDir))) {
      this.log(chalk.green('✓ Agor already initialized at: ') + chalk.cyan(baseDir));

      // If --set-config is enabled, update daemon config values (for Docker/deployment)
      if (flags['set-config']) {
        await this.setDaemonConfig(flags);
        this.log(chalk.green('✓ Daemon configuration updated'));
      }

      await this.warnExistingInstallTelemetryUnconfigured();

      this.log(chalk.dim('Skipping initialization (use --force to re-initialize)\n'));
      return;
    }

    try {
      const dbPath = join(baseDir, 'agor.db');
      const reposDir = join(baseDir, 'repos');
      const branchesDir = join(baseDir, 'worktrees');

      // Check if already initialized
      const alreadyExists = await this.pathExists(baseDir);
      const dbExists = await this.pathExists(dbPath);
      const reposExist = await this.pathExists(reposDir);
      const branchesExist = await this.pathExists(branchesDir);

      if (!alreadyExists) {
        // Fresh initialization
        await this.performInit(baseDir, dbPath, flags.force);
        return;
      }

      // Already initialized - need to decide what to do
      this.log(chalk.yellow('⚠  Agor is already initialized at: ') + chalk.cyan(baseDir));
      await this.warnExistingInstallTelemetryUnconfigured();
      this.log('');

      // Gather information about what exists
      const dbStats = dbExists ? await this.getDbStats(dbPath) : null;
      const repos = reposExist ? await this.listDirs(reposDir) : [];
      const branches = branchesExist ? await this.listDirs(branchesDir) : [];

      // Show what will be deleted
      this.log(chalk.bold.red('⚠  Re-initialization will delete:'));
      this.log('');

      if (dbExists && dbStats) {
        this.log(`${chalk.cyan('  Database:')} ${dbPath}`);
        this.log(
          chalk.dim(
            `    ${dbStats.sessions} sessions, ${dbStats.tasks} tasks, ${dbStats.messages} messages, ${dbStats.repos} repos`
          )
        );
      } else if (dbExists) {
        this.log(`${chalk.cyan('  Database:')} ${dbPath}`);
      }

      if (repos.length > 0) {
        this.log(`${chalk.cyan('  Repos:')} ${reposDir}`);
        for (const repo of repos.slice(0, 5)) {
          this.log(chalk.dim(`    - ${repo}`));
        }
        if (repos.length > 5) {
          this.log(chalk.dim(`    ... and ${repos.length - 5} more`));
        }
      }

      if (branches.length > 0) {
        this.log(`${chalk.cyan('  Branches:')} ${branchesDir}`);
        for (const wt of branches.slice(0, 5)) {
          this.log(chalk.dim(`    - ${wt}`));
        }
        if (branches.length > 5) {
          this.log(chalk.dim(`    ... and ${branches.length - 5} more`));
        }
      }

      this.log('');

      // If --force, skip prompts and nuke everything
      if (flags.force) {
        this.log(chalk.yellow('🗑️  --force flag set: deleting everything without prompts...'));
        await this.cleanupExisting(baseDir, dbPath, reposDir, branchesDir);
        await this.performInit(baseDir, dbPath, true);
        return;
      }

      // Prompt user for confirmation
      const { confirmed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: 'Delete all existing data and re-initialize?',
          default: false,
        },
      ]);

      if (!confirmed) {
        this.log(chalk.dim('Cancelled. Use --force to skip this prompt.'));
        process.exit(0);
        return;
      }

      // User confirmed - clean up and reinitialize
      await this.cleanupExisting(baseDir, dbPath, reposDir, branchesDir);
      await this.performInit(baseDir, dbPath, false);
    } catch (error) {
      this.error(
        `Failed to initialize Agor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Clean up existing installation
   */
  private async cleanupExisting(
    _baseDir: string,
    dbPath: string,
    reposDir: string,
    branchesDir: string
  ): Promise<void> {
    this.log('');
    this.log('🗑️  Cleaning up existing installation...');

    // Delete database
    if (await this.pathExists(dbPath)) {
      await rm(dbPath, { force: true });
      this.log(`${chalk.green('   ✓')} Deleted database`);
    }

    // Delete repos
    if (await this.pathExists(reposDir)) {
      await rm(reposDir, { recursive: true, force: true });
      this.log(`${chalk.green('   ✓')} Deleted repos`);
    }

    // Delete branches
    if (await this.pathExists(branchesDir)) {
      await rm(branchesDir, { recursive: true, force: true });
      this.log(`${chalk.green('   ✓')} Deleted branches`);
    }
  }

  /**
   * Perform fresh initialization
   */
  private async performInit(
    baseDir: string,
    dbPath: string,
    skipPrompts: boolean = false
  ): Promise<void> {
    // Create directory structure
    this.log('');
    this.log('📁 Creating directory structure...');
    const dirs = [
      baseDir,
      join(baseDir, 'repos'),
      join(baseDir, 'worktrees'),
      join(baseDir, 'concepts'),
      join(baseDir, 'logs'),
      join(baseDir, 'codex'),
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
      this.log(`${chalk.green('   ✓')} ${dir}`);
    }

    // Initialize database
    this.log('');
    this.log('💾 Setting up database...');
    const db = createDatabase({ url: `file:${dbPath}`, dialect: 'sqlite' });

    await runMigrations(db);
    this.log(`${chalk.green('   ✓')} Created ${dbPath}`);

    // Seed initial data
    this.log('');
    this.log('🌱 Seeding initial data...');
    await seedInitialData(db);
    this.log(`${chalk.green('   ✓')} Created Main Board`);

    // Create the admin user (auth is always required — anonymous mode was removed).
    if (!skipPrompts) {
      await this.promptAdminSetup(dbPath);
    } else {
      // --force: preserve local/dev ergonomics, but defer production admin
      // creation to the daemon-owned first-run bootstrap. This avoids
      // partially failing after destructive re-initialization has already
      // recreated the database and seeded initial data.
      if (process.env.NODE_ENV === 'production') {
        this.log(`${chalk.green('   ✓')} Admin setup deferred to daemon first-run bootstrap`);
        this.log(
          chalk.dim(
            '     Set AGOR_ADMIN_PASSWORD before daemon start, or use the generated admin-credentials file.'
          )
        );
      } else {
        try {
          const db = createDatabase({ url: `file:${dbPath}`, dialect: 'sqlite' });

          await createUser(db, {
            email: DEVELOPMENT_DEFAULT_ADMIN_USER.email,
            password: DEVELOPMENT_DEFAULT_ADMIN_USER.password,
            name: DEVELOPMENT_DEFAULT_ADMIN_USER.name,
            role: 'admin',
          });

          this.log(`${chalk.green('   ✓')} Development admin user created`);
          this.log(chalk.dim(`     Email: ${DEVELOPMENT_DEFAULT_ADMIN_USER.email}`));
          this.log(chalk.dim(`     Password: ${DEVELOPMENT_DEFAULT_ADMIN_USER.password}`));
          this.log(chalk.yellow(`     ⚠️  Development/test credential only.`));
        } catch (error) {
          // Admin user might already exist, which is fine
          if (error instanceof Error && !error.message.includes('UNIQUE constraint failed')) {
            throw error;
          }
        }
      }
    }

    if (!skipPrompts) {
      await this.promptTelemetrySetup();
    } else if (process.env.AGOR_TELEMETRY === undefined) {
      await this.saveTelemetryPreference(false, false);
    }

    // Success summary
    this.log('');
    this.log(chalk.green.bold('✅ Agor initialized successfully!'));
    this.log('');
    this.log(`   Database: ${chalk.cyan(dbPath)}`);
    this.log(`   Repos: ${chalk.cyan(join(baseDir, 'repos'))}`);
    this.log(`   Branches: ${chalk.cyan(join(baseDir, 'worktrees'))}`);
    this.log(`   Concepts: ${chalk.cyan(join(baseDir, 'concepts'))}`);
    this.log(`   Logs: ${chalk.cyan(join(baseDir, 'logs'))}`);
    this.log('');

    // Check if daemon is running
    const config = await loadConfig();
    const host = config.daemon?.host || 'localhost';
    const port = config.daemon?.port || 3030;
    const daemonRunning = await isDaemonRunning(`http://${host}:${port}`);
    const isDevMode = await this.isDevMode();

    this.log(chalk.bold('Next steps:'));
    if (daemonRunning) {
      this.log(chalk.yellow('   ⚠️  Daemon is currently running with old configuration'));
      this.log(chalk.yellow('   Please restart the daemon to apply changes:'));
      this.log('');
      this.log('   1. Stop the daemon (Ctrl+C in the daemon terminal)');
      if (isDevMode) {
        this.log('   2. Restart: cd apps/agor-daemon && pnpm dev');
      } else {
        this.log('   2. Restart: agor daemon start');
      }
    } else {
      if (isDevMode) {
        this.log('   1. Start the daemon: cd apps/agor-daemon && pnpm dev');
        this.log('   2. In another terminal, start the UI: cd apps/agor-ui && pnpm dev');
        this.log('   3. Open the UI: http://localhost:5173');
      } else {
        this.log('   1. Start the daemon: agor daemon start');
        this.log('   2. Open the UI: agor open');
      }
    }
    this.log('');
  }

  private getInstallChannel(): 'npm' | 'docker' | 'source' | 'homebrew' | 'unknown' {
    if (process.env.KUBERNETES_SERVICE_HOST || process.env.AGOR_DOCKER) {
      return 'docker';
    }
    if (process.env.HOMEBREW_PREFIX || process.execPath.includes('/Cellar/')) return 'homebrew';
    if (process.env.npm_config_global || process.env.npm_execpath) return 'npm';
    return 'unknown';
  }

  private getDeploymentKind(): 'local' | 'docker' | 'k8s' | 'unknown' {
    if (process.env.KUBERNETES_SERVICE_HOST) return 'k8s';
    if (process.env.container || process.env.AGOR_DOCKER) return 'docker';
    return 'local';
  }

  private async warnExistingInstallTelemetryUnconfigured(): Promise<void> {
    try {
      const config = await loadConfig();
      if (config.telemetry?.enabled !== undefined || isTelemetryFullyDisabledByEnv()) return;
      this.log('');
      this.log(
        chalk.yellow('ℹ  Open-source telemetry is not configured for this existing install.')
      );
      this.log(
        chalk.gray(
          `   Agor will not send telemetry unless an admin enables it. Learn more: ${AGOR_TELEMETRY_DOCS_URL}`
        )
      );
      this.log(chalk.gray('   To enable later: agor telemetry on'));
      this.log(chalk.gray('   To keep it disabled: agor telemetry off'));
    } catch {
      // Existing-install warning should never block init.
    }
  }

  private async saveTelemetryPreference(
    enabled: boolean,
    ensureInstanceId: boolean
  ): Promise<string | null> {
    const config = await loadConfig();
    const instanceId =
      config.telemetry?.instance_id ??
      (ensureInstanceId ? generateTelemetryInstanceId() : undefined);
    config.telemetry = {
      ...config.telemetry,
      enabled,
    };
    if (instanceId) {
      config.telemetry.instance_id = instanceId;
    }
    await saveConfig(pruneDefaultOpenSourceTelemetryDestination(config));
    return instanceId ?? null;
  }

  private async promptTelemetrySetup(): Promise<void> {
    if (isTelemetryFullyDisabledByEnv()) {
      await this.saveTelemetryPreference(false, false);
      this.log('');
      this.log(chalk.gray('Telemetry fully disabled by AGOR_TELEMETRY=0 or DO_NOT_TRACK=1.'));
      return;
    }

    this.log('');
    this.log(chalk.bold('📊 Anonymous telemetry'));
    this.log('');
    this.log(
      chalk.gray(
        'Agor sends one anonymous install ping so we can count installs and whether ongoing ' +
          'telemetry was enabled.'
      )
    );
    this.log(
      chalk.gray(
        'If enabled, Agor also sends occasional anonymous install and aggregate usage summaries.'
      )
    );
    this.log(
      chalk.gray(
        'We never send prompts, messages, repo names, file paths, user emails, ' +
          'branch/session/task IDs, code, tool output, secrets, or raw custom model names.'
      )
    );
    this.log(chalk.gray(`Learn more: ${AGOR_TELEMETRY_DOCS_URL}`));
    this.log(
      chalk.gray(
        'To disable all telemetry, including the one-time install ping, set AGOR_TELEMETRY=0.'
      )
    );
    this.log('');

    const { enabled } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'enabled',
        message: 'Enable ongoing anonymous telemetry?',
        default: true,
      },
    ]);

    const instanceId = await this.saveTelemetryPreference(enabled, true);
    await this.emitInstallTelemetry(enabled, instanceId);

    if (enabled) {
      this.log(`${chalk.green('   ✓')} Ongoing anonymous telemetry enabled`);
    } else {
      this.log(
        chalk.gray(
          '   Ongoing telemetry disabled. Sent only the one-time anonymous install result.'
        )
      );
    }
  }

  private async emitInstallTelemetry(enabled: boolean, instanceId: string | null): Promise<void> {
    if (!instanceId || isTelemetryFullyDisabledByEnv()) return;
    const config = await loadConfig();
    config.telemetry = { ...config.telemetry, enabled: true, instance_id: instanceId };
    const logger = createOpenSourceTelemetryLogger(config);
    logger.track({
      event: 'install.completed',
      properties: {
        agor_version: await loadOpenSourceTelemetryAgorVersion(
          this.config.version,
          import.meta.url
        ),
        install_channel: this.getInstallChannel(),
        deployment_kind: this.getDeploymentKind(),
        os_family: platform(),
        node_major: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
        ongoing_telemetry_enabled: enabled,
      },
    });
    await logger.flush();

    const saved = await loadConfig();
    saved.telemetry = {
      ...saved.telemetry,
      install_ping_sent_at: new Date().toISOString(),
    };
    await saveConfig(pruneDefaultOpenSourceTelemetryDestination(saved));
  }

  /**
   * Prompt user for admin account setup.
   *
   * Authentication is always required (anonymous mode was removed). If the
   * user skips the prompts here, the daemon will auto-bootstrap an admin on
   * first start (`runFirstRunAdminBootstrap`) and write credentials to
   * `~/.agor/admin-credentials`.
   */
  private async promptAdminSetup(dbPath: string): Promise<void> {
    this.log('');
    this.log(chalk.bold('👤 Create your admin account:'));
    this.log(chalk.gray('   (Skip this and the daemon will auto-create one on first start)'));
    this.log('');

    const { setupNow } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setupNow',
        message: 'Set up your admin account now?',
        default: true,
      },
    ]);

    if (!setupNow) {
      this.log(
        chalk.gray(
          '   Skipped. The daemon will create admin@agor.live on first start; the generated password lands in ~/.agor/admin-credentials.'
        )
      );
      return;
    }

    // Prompt for user details
    const { email, username, password } = await inquirer.prompt([
      {
        type: 'input',
        name: 'email',
        message: 'Email:',
        validate: (input: string) => {
          if (!input?.includes('@')) {
            return 'Please enter a valid email address';
          }
          return true;
        },
      },
      {
        type: 'input',
        name: 'username',
        message: 'Username:',
        validate: (input: string) => {
          if (!input || input.length < 2) {
            return 'Username must be at least 2 characters';
          }
          return true;
        },
      },
      {
        type: 'password',
        name: 'password',
        message: 'Password:',
        mask: '*',
        validate: (input: string) => {
          if (!input || input.length < 4) {
            return 'Password must be at least 4 characters';
          }
          return true;
        },
      },
    ]);

    // Create admin user directly in database (no daemon required)
    const db = createDatabase({ url: `file:${dbPath}`, dialect: 'sqlite' });

    const _user = await createUser(db, {
      email,
      password,
      name: username,
      role: 'admin',
    });

    this.log(`${chalk.green('   ✓')} Admin user created (${chalk.gray(email)})`);
  }

  /**
   * Set daemon configuration from flags or environment variables
   */
  private async setDaemonConfig(flags: {
    'daemon-port'?: number;
    'daemon-host'?: string;
    'instance-label'?: string;
  }): Promise<void> {
    // Get daemon port from flag or environment variable
    const daemonPort = flags['daemon-port'] || process.env.DAEMON_PORT;
    if (daemonPort) {
      await setConfigValue('daemon.port', Number(daemonPort));
      this.log(`${chalk.green('   ✓')} Set daemon.port = ${daemonPort}`);
    }

    // Get daemon host from flag or default
    const daemonHost = flags['daemon-host'] || 'localhost';
    await setConfigValue('daemon.host', daemonHost);
    this.log(`${chalk.green('   ✓')} Set daemon.host = ${daemonHost}`);

    // Get instance label from flag or environment variable
    const instanceLabel = flags['instance-label'] || process.env.INSTANCE_LABEL;
    if (instanceLabel) {
      await setConfigValue('daemon.instanceLabel', instanceLabel);
      this.log(`${chalk.green('   ✓')} Set daemon.instanceLabel = ${instanceLabel}`);
    }
  }
}
