/**
 * `agor init` - Initialize Agor environment
 *
 * Creates directory structure and initializes database.
 * Safe to run multiple times (idempotent).
 */

import { randomBytes } from 'node:crypto';
import { access, constants, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgorConfig,
  createInitialConfig,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
} from '@agor/core/config';
import {
  createDatabaseAsync,
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
import { getDaemonUrl } from '@agor-live/client/config';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { diagnoseAgenticTools } from '../lib/agentic-tool-diagnostics.js';
import {
  AGENTIC_TOOL_INTEGRATIONS,
  type InstallableAgenticTool,
  normalizeAgenticToolName,
  resolveManagedAgenticToolVersion,
} from '../lib/agentic-tool-integrations.js';

export function isFreshInitState(state: {
  baseExists: boolean;
  databaseExists: boolean;
  reposExist: boolean;
  branchesExist: boolean;
}): boolean {
  return !state.baseExists || (!state.databaseExists && !state.reposExist && !state.branchesExist);
}

export function createInstallTelemetryConfig(config: AgorConfig, instanceId: string): AgorConfig {
  return {
    ...config,
    telemetry: { ...config.telemetry, enabled: true, instance_id: instanceId },
  };
}

export function shouldDeferAdminSetup(nonInteractive: boolean, nodeEnv = process.env.NODE_ENV) {
  return nonInteractive || (nodeEnv !== 'development' && nodeEnv !== 'test');
}

/** Parse only the fixed integration allowlist; `all` and `none` are explicit headless shorthands. */
export function parseInitialAgenticTools(value: string): InstallableAgenticTool[] {
  const names = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(
      'Agentic-tool policy cannot be empty. Use `none` for an intentionally empty deployment.'
    );
  }
  if (names.length === 1 && names[0] === 'none') return [];
  if (names.length === 1 && names[0] === 'all') {
    return Object.keys(AGENTIC_TOOL_INTEGRATIONS) as InstallableAgenticTool[];
  }
  if (names.includes('all') || names.includes('none')) {
    throw new Error('Use `all` or `none` by itself, or provide a comma-separated tool list.');
  }
  const normalized = names.map(normalizeAgenticToolName);
  const unknown = names.filter((_, index) => !normalized[index]);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown agentic tool: ${unknown.join(', ')}. Choose from ${Object.keys(AGENTIC_TOOL_INTEGRATIONS).join(', ')}, all, or none.`
    );
  }
  return [...new Set(normalized as InstallableAgenticTool[])];
}

export default class Init extends Command {
  private initialDaemonConfig: NonNullable<AgorConfig['daemon']> = {};
  private initialConfig: AgorConfig = getDefaultConfig();
  private requestedAgenticTools: InstallableAgenticTool[] | undefined;
  private nonInteractive = false;
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
    'instance-label': Flags.string({
      description: 'Instance label for deployment identification (e.g., "staging", "prod-us-east")',
      required: false,
    }),
    'agentic-tools': Flags.string({
      description: 'Comma-separated agentic tools to configure and install (or "all" / "none")',
      required: false,
    }),
    'non-interactive': Flags.boolean({
      description: 'Initialize missing state without prompts or deleting existing data',
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

  /** Init owns config creation until this command returns; no other flow may use this helper. */
  private async persistDuringInitialCreation(config: AgorConfig): Promise<void> {
    config.daemon = {
      ...config.daemon,
      ...this.initialDaemonConfig,
      jwtSecret: config.daemon?.jwtSecret ?? randomBytes(32).toString('hex'),
      masterSecret: config.daemon?.masterSecret ?? randomBytes(32).toString('hex'),
    };
    if (await this.pathExists(getConfigPath())) return;
    await createInitialConfig(config);
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
    let closeDatabase: (() => void) | undefined;
    try {
      const { createDatabaseAsync, select, sessions, tasks, messages, repos } = await import(
        '@agor/core/db'
      );
      const db = await createDatabaseAsync({ url: `file:${dbPath}`, dialect: 'sqlite' });
      const client = (db as unknown as { $client?: { close?: () => void } }).$client;
      closeDatabase = () => client?.close?.();

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
    } finally {
      closeDatabase?.();
    }
  }

  private closeSQLiteDatabase(db: unknown): void {
    (db as { $client?: { close?: () => void } }).$client?.close?.();
  }

  private async assertDaemonStoppedBeforeReinit(): Promise<void> {
    // Use the same environment/config resolution and health probe as
    // `agor daemon status` so re-init cannot drift from the CLI's canonical
    // answer about which daemon endpoint is active.
    const daemonUrl = await getDaemonUrl();
    if (await isDaemonRunning(daemonUrl)) {
      throw new Error(
        `The Agor daemon is running at ${daemonUrl}. Stop it with \`agor daemon stop\` (or Ctrl+C for a development daemon) before re-initializing.`
      );
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
    this.nonInteractive = flags['non-interactive'];
    const requestedTools = flags['agentic-tools'] ?? process.env.AGOR_AGENTIC_TOOLS;
    if (requestedTools !== undefined) {
      try {
        this.requestedAgenticTools = parseInitialAgenticTools(requestedTools);
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
    }
    this.initialDaemonConfig = {
      host: flags['daemon-host'] ?? process.env.DAEMON_HOST ?? 'localhost',
      ...((flags['daemon-port'] ?? process.env.DAEMON_PORT)
        ? { port: Number(flags['daemon-port'] ?? process.env.DAEMON_PORT) }
        : {}),
      ...((flags['instance-label'] ?? process.env.INSTANCE_LABEL)
        ? { instanceLabel: flags['instance-label'] ?? process.env.INSTANCE_LABEL }
        : {}),
    };

    this.log('✨ Initializing Agor...\n');

    // Determine base directory early
    const baseDir = flags.local ? join(process.cwd(), '.agor') : join(homedir(), '.agor');

    // If --skip-if-exists and directory already exists, handle config and exit
    if (
      flags['skip-if-exists'] &&
      (await this.pathExists(join(baseDir, 'agor.db'))) &&
      (await this.pathExists(join(baseDir, 'config.yaml')))
    ) {
      this.log(chalk.green('✓ Agor already initialized at: ') + chalk.cyan(baseDir));

      await this.warnExistingInstallTelemetryUnconfigured();

      this.log(chalk.dim('Skipping initialization (use --force to re-initialize)\n'));
      return;
    }

    if (!flags.force && !this.nonInteractive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      this.error(
        'Interactive `agor init` requires a TTY. For headless setup, use `agor init --non-interactive --agentic-tools <comma-separated-list|all|none>`.'
      );
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
      const freshState = isFreshInitState({
        baseExists: alreadyExists,
        databaseExists: dbExists,
        reposExist,
        branchesExist,
      });

      if (freshState) {
        if (
          (flags.force || this.nonInteractive) &&
          process.env.AGOR_MANAGED_AGENTIC_TOOLS === '1' &&
          this.requestedAgenticTools === undefined &&
          !(await this.pathExists(getConfigPath()))
        ) {
          this.error(
            'Fresh noninteractive initialization requires an explicit agentic-tool policy. Pass `--agentic-tools <comma-separated-list|all|none>` (or set AGOR_AGENTIC_TOOLS).'
          );
        }
        // Fresh initialization
        await this.performInit(baseDir, dbPath, flags.force || this.nonInteractive);
        return;
      }

      // Already initialized - need to decide what to do
      this.log(chalk.yellow('⚠  Agor is already initialized at: ') + chalk.cyan(baseDir));
      await this.warnExistingInstallTelemetryUnconfigured();
      this.log('');

      if (this.nonInteractive) {
        this.error(
          'Refusing noninteractive re-initialization because existing data was found. Use --skip-if-exists for idempotent startup or run interactively to confirm destructive re-initialization.'
        );
      }

      // A live daemon owns the SQLite database and its WAL/SHM sidecars. Unlinking
      // those files underneath it can make the replacement migration fail with
      // SQLITE_IOERR (and can strand writes in the old unlinked database).
      await this.assertDaemonStoppedBeforeReinit();

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
    const databaseArtifacts = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    if ((await Promise.all(databaseArtifacts.map((path) => this.pathExists(path)))).some(Boolean)) {
      await Promise.all(databaseArtifacts.map((path) => rm(path, { force: true })));
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
    // Make the deployment choice before creating any state so rejecting the
    // empty selection (or cancelling the prompt) does not strand a partial DB.
    const configAlreadyExists = await this.pathExists(getConfigPath());
    const selectedTools = await this.selectInitialAgenticTools(skipPrompts);

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
    const db = await createDatabaseAsync({ url: `file:${dbPath}`, dialect: 'sqlite' });
    try {
      await runMigrations(db);
      this.log(`${chalk.green('   ✓')} Created ${dbPath}`);

      // Seed initial data
      this.log('');
      this.log('🌱 Seeding initial data...');
      await seedInitialData(db);
      this.log(`${chalk.green('   ✓')} Created Main Board`);
    } finally {
      this.closeSQLiteDatabase(db);
    }

    // Create the admin user (auth is always required — anonymous mode was removed).
    if (!skipPrompts) {
      await this.promptAdminSetup(dbPath);
    } else {
      // --force: preserve local/dev ergonomics, but defer production admin
      // creation to the daemon-owned first-run bootstrap. This avoids
      // partially failing after destructive re-initialization has already
      // recreated the database and seeded initial data.
      if (shouldDeferAdminSetup(this.nonInteractive)) {
        this.log(`${chalk.green('   ✓')} Admin setup deferred to daemon first-run bootstrap`);
        this.log(
          chalk.dim(
            '     Set AGOR_ADMIN_PASSWORD before daemon start, or use the generated admin-credentials file.'
          )
        );
      } else {
        try {
          const db = await createDatabaseAsync({ url: `file:${dbPath}`, dialect: 'sqlite' });
          try {
            await createUser(db, {
              email: DEVELOPMENT_DEFAULT_ADMIN_USER.email,
              password: DEVELOPMENT_DEFAULT_ADMIN_USER.password,
              name: DEVELOPMENT_DEFAULT_ADMIN_USER.name,
              role: 'admin',
            });
          } finally {
            this.closeSQLiteDatabase(db);
          }

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
      // Stamp a stable ID now so later opt-in never requires a config rewrite.
      // Explicit hard opt-out intentionally omits it.
      await this.saveTelemetryPreference(false, true);
    }
    this.initialConfig.agentic_tools = { installed: selectedTools };
    if (!configAlreadyExists) {
      await this.persistDuringInitialCreation(this.initialConfig);
    }
    if (process.env.AGOR_MANAGED_AGENTIC_TOOLS === '1') {
      try {
        await this.config.runCommand('install', ['--sync']);
      } catch (error) {
        throw new Error(
          `Agentic tool installation did not complete: ${error instanceof Error ? error.message : String(error)}. The new config was preserved. Recovery: agor install --sync`
        );
      }
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

    this.log(chalk.bold('Agentic tools:'));
    const configured = new Set(this.initialConfig.agentic_tools?.installed ?? []);
    const tools = await diagnoseAgenticTools(
      resolveManagedAgenticToolVersion(this.config.version) as string
    );
    for (const tool of tools) {
      const marker = tool.status === 'ready' ? chalk.green('✓') : chalk.yellow('○');
      const detail =
        tool.status === 'ready'
          ? (tool.version ?? tool.path ?? 'ready')
          : configured.has(tool.id)
            ? 'installation incomplete'
            : 'not selected by this deployment';
      this.log(`   ${marker} ${tool.name}: ${detail}`);
    }
    let missingTools = tools.filter((tool) => tool.status !== 'ready');
    missingTools = missingTools.filter((tool) => configured.has(tool.id));
    if (missingTools.length > 0) {
      this.log(chalk.dim(`   ${missingTools.length} optional agentic tool(s) are not installed.`));
      this.log(chalk.dim('   Repair the configured package set with: agor install --sync'));
      this.log(chalk.dim('   Recheck at any time with: agor doctor'));
    }
    this.log('');

    // Check if daemon is running
    const daemonUrl = await getDaemonUrl();
    const daemonRunning = await isDaemonRunning(daemonUrl);
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

  private async selectInitialAgenticTools(skipPrompts: boolean): Promise<InstallableAgenticTool[]> {
    if (await this.pathExists(getConfigPath())) {
      const existing = await loadConfig();
      this.initialConfig = existing;
      return existing.agentic_tools?.installed ?? [];
    }
    if (this.requestedAgenticTools) return this.requestedAgenticTools;
    if (process.env.AGOR_MANAGED_AGENTIC_TOOLS !== '1') return [];
    if (skipPrompts) {
      throw new Error(
        'Fresh noninteractive initialization requires an explicit agentic-tool policy. Pass `--agentic-tools <comma-separated-list|all|none>` (or set AGOR_AGENTIC_TOOLS).'
      );
    }

    const agorVersion = resolveManagedAgenticToolVersion(this.config.version) as string;
    this.log('');
    this.log(chalk.bold('Agentic tool packages'));
    this.log(
      chalk.dim(
        `Selected packages will be downloaded with npm, installed at ${agorVersion}, and recorded once in config.yaml.`
      )
    );
    this.log(
      chalk.dim(
        'Each selection uses additional disk and setup time. Provider credentials are configured after the daemon starts.'
      )
    );
    this.log(chalk.dim('Unchecked tools will not be available to workspaces on this deployment.'));
    const { selectedTools } = await inquirer.prompt<{ selectedTools: InstallableAgenticTool[] }>([
      {
        type: 'checkbox',
        name: 'selectedTools',
        message: 'Which agentic tools should this deployment support?',
        choices: Object.entries(AGENTIC_TOOL_INTEGRATIONS).map(([tool, definition]) => ({
          name: `${definition.displayName} (${definition.packageName}@${agorVersion})`,
          value: tool,
        })),
        validate: (selection) =>
          selection.length > 0 || 'Select at least one agentic tool, or press Ctrl+C to exit.',
      },
    ]);
    return selectedTools;
  }

  private async warnExistingInstallTelemetryUnconfigured(): Promise<void> {
    try {
      const config = await loadConfig();
      if (config.telemetry?.enabled !== undefined || isTelemetryFullyDisabledByEnv()) return;
      this.log('');
      this.log(chalk.yellow('ℹ  Community telemetry is not configured for this existing install.'));
      this.log(
        chalk.gray(
          `   Agor will not send telemetry unless an admin enables it. Learn more: ${AGOR_TELEMETRY_DOCS_URL}`
        )
      );
      this.log(
        chalk.gray(
          '   Configure later with AGOR_TELEMETRY=1/0 or telemetry.enabled in config.yaml.'
        )
      );
    } catch {
      // Existing-install warning should never block init.
    }
  }

  private async saveTelemetryPreference(
    enabled: boolean,
    ensureInstanceId: boolean
  ): Promise<string | null> {
    const config = (await this.pathExists(getConfigPath()))
      ? await loadConfig()
      : this.initialConfig;
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
    this.initialConfig = pruneDefaultOpenSourceTelemetryDestination(config);
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
    const config = (await this.pathExists(getConfigPath()))
      ? await loadConfig()
      : this.initialConfig;
    // The one-time install ping needs telemetry enabled for this logger only.
    // Never mutate initialConfig: it contains the user's persisted opt-in choice.
    const logger = createOpenSourceTelemetryLogger(
      createInstallTelemetryConfig(config, instanceId)
    );
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
    const db = await createDatabaseAsync({ url: `file:${dbPath}`, dialect: 'sqlite' });
    try {
      await createUser(db, {
        email,
        password,
        name: username,
        role: 'admin',
      });
    } finally {
      this.closeSQLiteDatabase(db);
    }

    this.log(`${chalk.green('   ✓')} Admin user created (${chalk.gray(email)})`);
  }
}
