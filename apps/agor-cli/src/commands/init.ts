/**
 * `agor init` - Initialize Agor environment
 *
 * Creates directory structure and initializes database.
 * Safe to run multiple times (idempotent).
 */

import { access, constants, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDaemonRunning } from '@agor/core/api';
import { loadConfig, setConfigValue } from '@agor/core/config';
import { createDatabase, createUser, runMigrations, seedInitialData } from '@agor/core/db';
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
        'Force re-initialization without prompts (deletes database, repos, and worktrees)',
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
      const { createDatabase, sessions, tasks, messages, repos } = await import('@agor/core/db');
      const db = createDatabase({ url: `file:${dbPath}` });

      // Count rows by selecting all and measuring length
      const sessionRows = await db.select({ id: sessions.session_id }).from(sessions).all();
      const taskRows = await db.select({ id: tasks.task_id }).from(tasks).all();
      const messageRows = await db.select({ id: messages.message_id }).from(messages).all();
      const repoRows = await db.select({ id: repos.repo_id }).from(repos).all();

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
   * List directories in a path (repos, worktrees)
   */
  private async listDirs(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Detect if running in GitHub Codespaces
   */
  private isCodespaces(): boolean {
    return process.env.CODESPACES === 'true' || process.env.CODESPACE_NAME !== undefined;
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

      this.log(chalk.dim('Skipping initialization (use --force to re-initialize)\n'));
      return;
    }

    // Show Codespaces-specific welcome if detected
    if (this.isCodespaces() && !flags.force) {
      this.log(chalk.cyan.bold('🚀 GitHub Codespaces detected!\n'));
      this.log(chalk.yellow('⚠️  Sandbox Mode:'));
      this.log('   - Data persists only while Codespace is active');
      this.log('   - Stopped Codespaces retain data for 30 days');
      this.log('   - Rebuilt Codespaces lose all data\n');
      this.log(chalk.dim('For production use, install Agor locally:'));
      this.log(chalk.dim('  https://github.com/preset-io/agor#installation\n'));
    }

    try {
      const dbPath = join(baseDir, 'agor.db');
      const reposDir = join(baseDir, 'repos');
      const worktreesDir = join(baseDir, 'worktrees');

      // Check if already initialized
      const alreadyExists = await this.pathExists(baseDir);
      const dbExists = await this.pathExists(dbPath);
      const reposExist = await this.pathExists(reposDir);
      const worktreesExist = await this.pathExists(worktreesDir);

      if (!alreadyExists) {
        // Fresh initialization
        await this.performInit(baseDir, dbPath, flags.force);
        return;
      }

      // Already initialized - need to decide what to do
      this.log(chalk.yellow('⚠  Agor is already initialized at: ') + chalk.cyan(baseDir));
      this.log('');

      // Gather information about what exists
      const dbStats = dbExists ? await this.getDbStats(dbPath) : null;
      const repos = reposExist ? await this.listDirs(reposDir) : [];
      const worktrees = worktreesExist ? await this.listDirs(worktreesDir) : [];

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

      if (worktrees.length > 0) {
        this.log(`${chalk.cyan('  Worktrees:')} ${worktreesDir}`);
        for (const wt of worktrees.slice(0, 5)) {
          this.log(chalk.dim(`    - ${wt}`));
        }
        if (worktrees.length > 5) {
          this.log(chalk.dim(`    ... and ${worktrees.length - 5} more`));
        }
      }

      this.log('');

      // If --force, skip prompts and nuke everything
      if (flags.force) {
        this.log(chalk.yellow('🗑️  --force flag set: deleting everything without prompts...'));
        await this.cleanupExisting(baseDir, dbPath, reposDir, worktreesDir);
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
      await this.cleanupExisting(baseDir, dbPath, reposDir, worktreesDir);
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
    worktreesDir: string
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

    // Delete worktrees
    if (await this.pathExists(worktreesDir)) {
      await rm(worktreesDir, { recursive: true, force: true });
      this.log(`${chalk.green('   ✓')} Deleted worktrees`);
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
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
      this.log(`${chalk.green('   ✓')} ${dir}`);
    }

    // Initialize database
    this.log('');
    this.log('💾 Setting up database...');
    const db = createDatabase({ url: `file:${dbPath}` });

    await runMigrations(db);
    this.log(`${chalk.green('   ✓')} Created ${dbPath}`);

    // Seed initial data
    this.log('');
    this.log('🌱 Seeding initial data...');
    await seedInitialData(db);
    this.log(`${chalk.green('   ✓')} Created Main Board`);

    // Prompt for auth/multiplayer setup (unless --force)
    if (!skipPrompts) {
      await this.promptAuthSetup(dbPath);
    } else {
      // With --force, enable auth by default (multiplayer mode) with default admin user
      await setConfigValue('daemon.requireAuth', true);
      await setConfigValue('daemon.allowAnonymous', false);
      this.log(`${chalk.green('   ✓')} Enabled authentication (multiplayer mode)`);

      // Create default admin user with credentials displayed to user
      try {
        const db = createDatabase({ url: `file:${dbPath}` });
        const defaultEmail = 'admin@agor.live';
        const defaultPassword = 'admin';

        await createUser(db, {
          email: defaultEmail,
          password: defaultPassword,
          name: 'Admin',
          role: 'admin',
        });

        this.log(`${chalk.green('   ✓')} Default admin user created`);
        this.log(chalk.dim(`     Email: ${defaultEmail}`));
        this.log(chalk.dim(`     Password: ${defaultPassword}`));
        this.log(chalk.yellow(`     ⚠️  Change this password after first login!`));
      } catch (error) {
        // Admin user might already exist, which is fine
        if (error instanceof Error && !error.message.includes('UNIQUE constraint failed')) {
          throw error;
        }
      }
    }

    // Success summary
    this.log('');
    this.log(chalk.green.bold('✅ Agor initialized successfully!'));
    this.log('');
    this.log(`   Database: ${chalk.cyan(dbPath)}`);
    this.log(`   Repos: ${chalk.cyan(join(baseDir, 'repos'))}`);
    this.log(`   Worktrees: ${chalk.cyan(join(baseDir, 'worktrees'))}`);
    this.log(`   Concepts: ${chalk.cyan(join(baseDir, 'concepts'))}`);
    this.log(`   Logs: ${chalk.cyan(join(baseDir, 'logs'))}`);
    this.log('');

    // Show API key guidance if in Codespaces
    if (this.isCodespaces()) {
      this.log(chalk.bold('📝 API Key Setup (Optional):'));
      this.log('');
      this.log('To use AI agents (Claude, Gemini, etc.), set API keys:');
      this.log('');
      this.log(chalk.cyan('1. Environment variables (recommended for Codespaces):'));
      this.log('   export ANTHROPIC_API_KEY="sk-ant-..."');
      this.log('   export OPENAI_API_KEY="sk-..."');
      this.log('   export GOOGLE_AI_API_KEY="..."');
      this.log('');
      this.log(chalk.cyan('2. Codespaces Secrets (persistent across rebuilds):'));
      this.log('   GitHub → Settings → Codespaces → Secrets');
      this.log('   Add keys there and rebuild Codespace');
      this.log('');
      this.log(chalk.yellow('💡 Tip: To preserve your work:'));
      this.log('   - Keep Codespace active (auto-stops after 30 min idle)');
      this.log('   - Export important sessions before stopping');
      this.log('   - Use git to commit session transcripts');
      this.log('');
    }

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

  /**
   * Prompt user for auth/multiplayer setup
   */
  private async promptAuthSetup(dbPath: string): Promise<void> {
    this.log('');

    const { enableAuth } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'enableAuth',
        message: 'Enable authentication and multiplayer features?',
        default: true,
      },
    ]);

    if (!enableAuth) {
      this.log(chalk.gray('Authentication disabled. Running in single-user mode.'));
      this.log('');
      this.log(chalk.gray('You can enable auth later with:'));
      this.log(chalk.gray('  agor config set daemon.requireAuth true'));
      this.log(chalk.gray('  agor user create-admin'));
      return;
    }

    // Enable auth in config
    await setConfigValue('daemon.requireAuth', true);
    await setConfigValue('daemon.allowAnonymous', false);
    this.log(`${chalk.green('   ✓')} Enabled authentication`);

    // Admin user is required when auth is enabled
    this.log('');
    this.log(chalk.bold('👤 Create your admin account:'));
    this.log('');

    // Prompt for user details
    const { email, username, password } = await inquirer.prompt([
      {
        type: 'input',
        name: 'email',
        message: 'Email:',
        validate: (input: string) => {
          if (!input || !input.includes('@')) {
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
    const db = createDatabase({ url: `file:${dbPath}` });

    const user = await createUser(db, {
      email,
      password,
      name: username,
      role: 'admin',
    });

    this.log(chalk.green('   ✓') + ` Admin user created (${chalk.gray(email)})`);
  }

  /**
   * Prompt user for API key setup
   */
  private async promptApiKeys(): Promise<void> {
    this.log('');
    this.log(chalk.bold('🔑 API Key Setup'));
    this.log('');
    this.log(chalk.gray('Configure API keys for AI agents (optional, can be set later)'));
    this.log('');

    const { setupKeys } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setupKeys',
        message: 'Set up API keys now?',
        default: false,
      },
    ]);

    if (!setupKeys) {
      this.log('');
      this.log(chalk.gray('Skipped. You can set API keys later with:'));
      this.log(chalk.gray('  agor config set credentials.ANTHROPIC_API_KEY "sk-ant-..."'));
      this.log(chalk.gray('  agor config set credentials.OPENAI_API_KEY "sk-..."'));
      this.log(chalk.gray('  agor config set credentials.GEMINI_API_KEY "..."'));
      return;
    }

    // Anthropic API Key
    const { setupAnthropic } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setupAnthropic',
        message: 'Set up Anthropic API key (for Claude Code)?',
        default: true,
      },
    ]);

    if (setupAnthropic) {
      const { anthropicKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'anthropicKey',
          message: 'Anthropic API key (sk-ant-...):',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.length < 10) {
              return 'Please enter a valid API key';
            }
            return true;
          },
        },
      ]);

      await setConfigValue('credentials.ANTHROPIC_API_KEY', anthropicKey);
      this.log(`${chalk.green('   ✓')} Anthropic API key saved`);
    }

    // OpenAI API Key
    const { setupOpenAI } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setupOpenAI',
        message: 'Set up OpenAI API key (for Codex)?',
        default: false,
      },
    ]);

    if (setupOpenAI) {
      const { openaiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'openaiKey',
          message: 'OpenAI API key (sk-...):',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.length < 10) {
              return 'Please enter a valid API key';
            }
            return true;
          },
        },
      ]);

      await setConfigValue('credentials.OPENAI_API_KEY', openaiKey);
      this.log(`${chalk.green('   ✓')} OpenAI API key saved`);
    }

    // Google Gemini API Key
    const { setupGemini } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setupGemini',
        message: 'Set up Google Gemini API key?',
        default: false,
      },
    ]);

    if (setupGemini) {
      const { geminiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'geminiKey',
          message: 'Google Gemini API key:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.length < 10) {
              return 'Please enter a valid API key';
            }
            return true;
          },
        },
      ]);

      await setConfigValue('credentials.GEMINI_API_KEY', geminiKey);
      this.log(`${chalk.green('   ✓')} Gemini API key saved`);
    }

    this.log('');
    this.log(
      chalk.gray('Note: API keys are stored in ~/.agor/config.yaml (keep this file secure!)')
    );
  }

  /**
   * Set daemon configuration from flags or environment variables
   */
  private async setDaemonConfig(flags: {
    'daemon-port'?: number;
    'daemon-host'?: string;
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

    // Enable authentication for Docker/deployment environments
    await setConfigValue('daemon.requireAuth', true);
    await setConfigValue('daemon.allowAnonymous', false);
    this.log(`${chalk.green('   ✓')} Enabled authentication`);

    // Set OpenCode server URL (Docker-specific)
    await setConfigValue('opencode.enabled', true);
    await setConfigValue('opencode.serverUrl', 'http://host.docker.internal:4096');
    this.log(`${chalk.green('   ✓')} Configured OpenCode server`);
  }
}
