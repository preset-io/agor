/**
 * `agor init` - Initialize Agor environment
 *
 * Creates directory structure and initializes database.
 * Safe to run multiple times (idempotent).
 */

import { randomUUID } from 'node:crypto';
import { access, chmod, constants, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgenticToolSelectionPolicy } from '@agor/core/agentic-integrations';
import {
  type AgorConfig,
  assertSecurePassword,
  createInitialConfig,
  ensureAgorHome,
  getConfigPath,
  getDaemonUrl,
  getDefaultConfig,
  loadConfig,
  prepareInitialDeploymentConfig,
} from '@agor/core/config';
import {
  createDatabaseAsync,
  createDevelopmentDefaultAdminUser,
  createUser,
  DEVELOPMENT_DEFAULT_ADMIN_USER,
  isDevelopmentDefaultAdminEnvironment,
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
import { diagnoseGit } from '@agor/git';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { diagnoseAgenticTools } from '../lib/agentic-tool-diagnostics.js';
import {
  AGENTIC_TOOL_INTEGRATIONS,
  type InstallableAgenticTool,
  normalizeAgenticToolName,
  resolveManagedAgenticToolVersion,
  validateInteractiveAgenticToolSelection,
  writeAgenticToolSelectionManifest,
} from '../lib/agentic-tool-integrations.js';
import { getDaemonPid, getManagedDaemonIdentity } from '../lib/daemon-manager.js';
import { probeAgorDaemon } from '../lib/daemon-probe.js';
import { assertLocalContextUnlockedWhenIdentified } from '../lib/local-context.js';

export function isFreshInitState(state: {
  baseExists: boolean;
  configExists: boolean;
  databaseExists: boolean;
  reposExist: boolean;
  branchesExist: boolean;
}): boolean {
  return (
    !state.baseExists ||
    (!state.configExists && !state.databaseExists && !state.reposExist && !state.branchesExist)
  );
}

export function createInstallTelemetryConfig(config: AgorConfig, instanceId: string): AgorConfig {
  return {
    ...config,
    telemetry: { ...config.telemetry, enabled: true, instance_id: instanceId },
  };
}

export function shouldDeferAdminSetup(
  nonInteractive: boolean,
  env: NodeJS.ProcessEnv = process.env
) {
  return nonInteractive || !isDevelopmentDefaultAdminEnvironment(env);
}

/** Inquirer-compatible validation using the canonical server password policy. */
export function validateInitAdminPassword(input: unknown, email?: string): true | string {
  try {
    assertSecurePassword(input, { email });
    return true;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function formatInitBackupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export async function moveInstallToPrivateBackup(
  baseDir: string,
  options: {
    date?: Date;
    pathExists?: (path: string) => Promise<boolean>;
  } = {}
): Promise<string> {
  const pathExists =
    options.pathExists ??
    (async (path: string) => {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    });
  const prefix = `${baseDir}.bkp.${formatInitBackupTimestamp(options.date)}`;
  let backupDir = prefix;
  for (let suffix = 2; await pathExists(backupDir); suffix += 1) {
    backupDir = `${prefix}.${suffix}`;
  }

  // Re-init backups co-locate the encrypted database with config.yaml's
  // deployment key and may also contain native agent credentials. Preserve
  // neither a legacy permissive mode nor the caller's umask accident. Tighten
  // before the atomic rename so there is no permissive backup-name window.
  await chmod(baseDir, 0o700);
  await rename(baseDir, backupDir);
  await chmod(backupDir, 0o700);
  return backupDir;
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

export function assertInitSupportsConfiguredDatabase(dialect = process.env.AGOR_DB_DIALECT): void {
  if (dialect === 'postgresql') {
    throw new Error(
      '`agor init` currently supports SQLite installations only. For PostgreSQL deployments, configure the deployment environment and run `agor db migrate --yes`; the daemon will bootstrap required database state.'
    );
  }
}

export default class Init extends Command {
  private readonly deploymentId = randomUUID();
  private initialDaemonConfig: NonNullable<AgorConfig['daemon']> = {
    deployment_id: this.deploymentId,
  };
  private initialConfig: AgorConfig = {
    ...getDefaultConfig(),
    daemon: { ...getDefaultConfig().daemon, deployment_id: this.deploymentId },
  };
  private requestedAgenticTools: InstallableAgenticTool[] | undefined;
  private selectedAgenticTools: InstallableAgenticTool[] | undefined;
  private nonInteractive = false;
  static description =
    'Create the Agor config/database and install the agentic tools selected for first use';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    local: Flags.boolean({
      char: 'l',
      description: 'Deprecated: per-directory installations are no longer supported',
      default: false,
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Force re-initialization without prompts (deletes the entire .agor directory)',
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
    config = prepareInitialDeploymentConfig(
      { ...config, daemon: { ...config.daemon, ...this.initialDaemonConfig } },
      { deploymentId: this.deploymentId }
    );
    if (await this.pathExists(getConfigPath())) return;
    await createInitialConfig(config);
  }

  private resetFreshConfig(): void {
    const defaults = getDefaultConfig();
    this.initialConfig = {
      ...defaults,
      daemon: { ...defaults.daemon, ...this.initialDaemonConfig },
    };
  }

  private expandHome(path: string): string {
    if (path.startsWith('~/')) {
      return join(homedir(), path.slice(2));
    }
    return path;
  }

  private closeSQLiteDatabase(db: unknown): void {
    (db as { $client?: { close?: () => void } }).$client?.close?.();
  }

  private async assertDaemonStoppedBeforeReinit(): Promise<void> {
    // Use the same environment/config resolution and health probe as
    // `agor daemon status` so re-init cannot drift from the CLI's canonical
    // answer about which daemon endpoint is active.
    //
    // Only consider daemons that belong to *this* Agor home. A daemon this home
    // manages (PID file present) always counts. The configured URL counts only once
    // a config exists here — otherwise `getDaemonUrl()` hands back the global
    // default and initializing a brand-new home fails because some unrelated
    // deployment happens to occupy that port. That false positive also made the
    // `agor init` test suite dependent on no daemon running on 3030.
    const managedUrl = getDaemonPid() !== null ? getManagedDaemonIdentity()?.daemonUrl : undefined;

    // A daemon this home manages is unambiguously ours, whatever it answers with.
    if (managedUrl && (await probeAgorDaemon(managedUrl)).running) {
      throw new Error(this.daemonRunningMessage(managedUrl));
    }

    if (!(await this.pathExists(getConfigPath()))) return;

    const configuredUrl = await getDaemonUrl();
    if (!configuredUrl || configuredUrl === managedUrl) return;

    const probe = await probeAgorDaemon(configuredUrl);
    if (!probe.running) return;

    // Something is answering on our configured port, but a port is not ownership.
    // Only block when it is demonstrably the same deployment; otherwise this is an
    // unrelated daemon and re-initializing here cannot disturb it.
    const ourDeploymentId = (await loadConfig().catch(() => undefined))?.daemon?.deployment_id;
    if (ourDeploymentId && probe.deploymentId && probe.deploymentId !== ourDeploymentId) return;

    throw new Error(this.daemonRunningMessage(configuredUrl));
  }

  private daemonRunningMessage(daemonUrl: string): string {
    return `The Agor daemon is running at ${daemonUrl}. Stop it with \`agor daemon stop\` (or Ctrl+C for a development daemon) before re-initializing.`;
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
    assertInitSupportsConfiguredDatabase();
    if (flags.local) {
      this.error(
        '`agor init --local` is no longer supported because daemon configuration and data must share one canonical installation at ~/.agor. Run `agor init` without --local.'
      );
    }
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
      deployment_id: this.deploymentId,
      host: flags['daemon-host'] ?? process.env.DAEMON_HOST ?? 'localhost',
      ...((flags['daemon-port'] ?? process.env.DAEMON_PORT)
        ? { port: Number(flags['daemon-port'] ?? process.env.DAEMON_PORT) }
        : {}),
      ...((flags['instance-label'] ?? process.env.INSTANCE_LABEL)
        ? { instanceLabel: flags['instance-label'] ?? process.env.INSTANCE_LABEL }
        : {}),
    };

    this.log('✨ Initializing Agor...\n');

    // Git is a runtime prerequisite for remote clones and branch/worktree
    // materialization. Check before creating any state so a minimal fresh host
    // fails here with remediation instead of later in the onboarding wizard.
    const git = await diagnoseGit();
    if (git.status !== 'ready') this.error(git.detail ?? 'Git is unavailable.');
    this.log(`${chalk.green('✓')} Git ${git.version} is executable (${git.binary})`);

    // Determine base directory early
    const baseDir = join(homedir(), '.agor');
    if (await this.pathExists(join(baseDir, 'config.yaml'))) {
      await assertLocalContextUnlockedWhenIdentified(await loadConfig());
    }

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

    // Fail before any onboarding/destructive prompts. This also catches a
    // partially initialized legacy install whose database is missing while
    // its daemon still owns open database/WAL handles.
    try {
      await this.assertDaemonStoppedBeforeReinit();
    } catch (error) {
      this.error(
        `Failed to initialize Agor: ${error instanceof Error ? error.message : String(error)}`
      );
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
      const configExists = await this.pathExists(join(baseDir, 'config.yaml'));
      const dbExists = await this.pathExists(dbPath);
      const reposExist = await this.pathExists(reposDir);
      const branchesExist = await this.pathExists(branchesDir);
      const freshState = isFreshInitState({
        baseExists: alreadyExists,
        configExists,
        databaseExists: dbExists,
        reposExist,
        branchesExist,
      });

      if (freshState) {
        if (
          (flags.force || this.nonInteractive) &&
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

      // Gather information about what exists
      const repos = reposExist ? await this.listDirs(reposDir) : [];
      const branches = branchesExist ? await this.listDirs(branchesDir) : [];

      // The action applies to the directory as one deployment boundary, not
      // only to the well-known paths we can summarize below.
      this.log(chalk.bold.yellow('⚠  Re-initialization affects the entire installation:'));
      this.log(`${chalk.cyan('  Directory:')} ${baseDir}`);
      this.log(
        chalk.dim(
          '    Backup moves it intact. Delete permanently removes everything in it, including config.yaml, database sidecars, logs, repositories, worktrees, and installed tools.'
        )
      );
      this.log('');

      if (dbExists) {
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
        await this.prepareAgenticToolSelection(true);
        this.resetFreshConfig();
        this.log(chalk.yellow('🗑️  --force flag set: deleting everything without prompts...'));
        await this.deleteExistingInstall(baseDir);
        await this.performInit(baseDir, dbPath, true);
        return;
      }

      const { action } = await inquirer.prompt<{
        action: 'backup' | 'delete' | 'cancel';
      }>([
        {
          type: 'list',
          name: 'action',
          message: 'How would you like to re-initialize?',
          choices: [
            { name: 'Back up and re-initialize (recommended)', value: 'backup' },
            { name: 'Delete and re-initialize', value: 'delete' },
            { name: 'Cancel', value: 'cancel' },
          ],
        },
      ]);

      if (action === 'cancel') {
        this.log(chalk.dim('Cancelled. Use --force to skip this prompt.'));
        return;
      }

      // Resolve upgraded-install tool policy before deleting anything. A
      // missing headless policy or a cancelled selector must leave data intact.
      await this.prepareAgenticToolSelection(false);
      // Tool selection may inspect the old config, but a re-init establishes a
      // new deployment boundary with fresh identity and secrets.
      this.resetFreshConfig();

      if (action === 'backup') {
        await this.backupExistingInstall(baseDir);
      } else {
        await this.deleteExistingInstall(baseDir);
      }
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
  private async deleteExistingInstall(baseDir: string): Promise<void> {
    this.log('');
    this.log('🗑️  Cleaning up existing installation...');
    await rm(baseDir, { recursive: true, force: true });
    this.log(`${chalk.green('   ✓')} Deleted ${baseDir}`);
  }

  private async backupExistingInstall(baseDir: string): Promise<void> {
    this.log('');
    this.log('📦 Backing up existing installation...');
    const backupDir = await moveInstallToPrivateBackup(baseDir, {
      pathExists: (path) => this.pathExists(path),
    });
    this.log(`${chalk.green('   ✓')} Moved ${baseDir} to ${backupDir}`);
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
    const selectedTools = await this.prepareAgenticToolSelection(skipPrompts);

    // Create directory structure
    this.log('');
    this.log('📁 Creating directory structure...');
    await ensureAgorHome(baseDir);
    this.log(`${chalk.green('   ✓')} ${baseDir}`);

    const dirs = [
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
    } finally {
      this.closeSQLiteDatabase(db);
    }

    // Create the admin user (auth is always required — anonymous mode was removed).
    let initialOwnerId: string | null = null;
    if (!skipPrompts) {
      initialOwnerId = await this.promptAdminSetup(dbPath);
    } else {
      // --force: preserve local/dev ergonomics, but defer production admin
      // creation to the daemon-owned first-run bootstrap. This avoids
      // partially failing after destructive re-initialization has recreated
      // the database. The daemon will create both the User and default Board.
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
            const owner = await createDevelopmentDefaultAdminUser(db);
            initialOwnerId = owner.user_id;
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

    if (initialOwnerId) {
      const db = await createDatabaseAsync({ url: `file:${dbPath}`, dialect: 'sqlite' });
      try {
        this.log('');
        this.log('🌱 Seeding initial data...');
        await seedInitialData(db, initialOwnerId);
        this.log(`${chalk.green('   ✓')} Created Main Board`);
      } finally {
        this.closeSQLiteDatabase(db);
      }
    }

    if (!skipPrompts) {
      await this.promptTelemetrySetup();
    } else if (process.env.AGOR_TELEMETRY === undefined) {
      // Stamp a stable ID now so later opt-in never requires a config rewrite.
      // Explicit hard opt-out intentionally omits it.
      await this.saveTelemetryPreference(false, true);
    }
    if (!configAlreadyExists) {
      this.initialConfig.agentic_tools = { installed: selectedTools };
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
      const isConfigured = configured.has(tool.id);
      const marker =
        tool.status === 'ready'
          ? chalk.green('✓')
          : isConfigured
            ? chalk.yellow('⚠')
            : chalk.dim('○');
      const detail =
        tool.status === 'ready'
          ? (tool.version ?? tool.path ?? 'ready')
          : isConfigured
            ? 'installation incomplete'
            : 'not selected by this deployment';
      this.log(`   ${marker} ${tool.name}: ${detail}`);
    }
    let missingTools = tools.filter((tool) => tool.status !== 'ready');
    missingTools = missingTools.filter((tool) => configured.has(tool.id));
    if (missingTools.length > 0) {
      this.log(
        chalk.yellow(
          `   ${missingTools.length} selected agentic tool(s) need installation or repair.`
        )
      );
      this.log(chalk.dim('   Repair the configured package set with: agor install --sync'));
      this.log(chalk.dim('   Recheck at any time with: agor doctor'));
    }
    this.log('');

    // Check if daemon is running
    const daemonUrl = await getDaemonUrl();
    const daemonRunning = (await probeAgorDaemon(daemonUrl)).running;
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
      const declared = existing.agentic_tools?.installed;
      if (declared !== undefined) {
        if (
          this.requestedAgenticTools &&
          this.requestedAgenticTools.join(',') !== declared.join(',')
        ) {
          throw new Error(
            'agentic_tools.installed is deployment-owned in config.yaml. Edit it explicitly instead of passing --agentic-tools.'
          );
        }
        if (this.requestedAgenticTools) return this.requestedAgenticTools;
        if (skipPrompts) return declared;
        return await this.promptForAgenticTools(declared);
      }

      const policy = await resolveAgenticToolSelectionPolicy(existing);
      if (this.requestedAgenticTools) {
        await writeAgenticToolSelectionManifest(this.requestedAgenticTools);
        return this.requestedAgenticTools;
      }
      if (skipPrompts) {
        if (policy.source === 'missing-manifest') {
          throw new Error(
            'This upgraded install has no agentic-tool selection. Pass --agentic-tools <comma-separated-list|all|none> before re-initializing.'
          );
        }
        return [...policy.selected];
      }

      const selected = await this.promptForAgenticTools(policy.selected);
      await writeAgenticToolSelectionManifest(selected);
      return selected;
    }
    if (this.requestedAgenticTools) return this.requestedAgenticTools;
    if (skipPrompts) {
      throw new Error(
        'Fresh noninteractive initialization requires an explicit agentic-tool policy. Pass `--agentic-tools <comma-separated-list|all|none>` (or set AGOR_AGENTIC_TOOLS).'
      );
    }

    return await this.promptForAgenticTools();
  }

  private async prepareAgenticToolSelection(
    skipPrompts: boolean
  ): Promise<InstallableAgenticTool[]> {
    this.selectedAgenticTools ??= await this.selectInitialAgenticTools(skipPrompts);
    return this.selectedAgenticTools;
  }

  private async promptForAgenticTools(
    previouslySelected: readonly InstallableAgenticTool[] = []
  ): Promise<InstallableAgenticTool[]> {
    const agorVersion = resolveManagedAgenticToolVersion(this.config.version) as string;
    const checked = new Set(previouslySelected);
    this.log('');
    this.log(chalk.bold('Agentic tool packages'));
    this.log(
      chalk.dim(
        `Selected packages will be downloaded with npm, installed at ${agorVersion}, and recorded as this deployment's tool policy.`
      )
    );
    this.log(
      chalk.dim(
        'Each selection uses additional disk and setup time. Provider credentials are configured after the daemon starts.'
      )
    );
    this.log(chalk.dim('Unchecked tools will not be available to workspaces on this deployment.'));
    this.log(chalk.dim('Use ↑/↓ to move, Space to select, and Enter to continue.'));
    const { selectedTools } = await inquirer.prompt<{ selectedTools: InstallableAgenticTool[] }>([
      {
        type: 'checkbox',
        name: 'selectedTools',
        message: 'Which agentic tools should this deployment support?',
        choices: Object.entries(AGENTIC_TOOL_INTEGRATIONS).map(([tool, definition]) => ({
          name: `${definition.displayName} (${definition.packageName}@${agorVersion})`,
          value: tool,
          checked: checked.has(tool as InstallableAgenticTool),
        })),
        validate: validateInteractiveAgenticToolSelection,
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
  private async promptAdminSetup(dbPath: string): Promise<string | null> {
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
      return null;
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
        validate: (input: string) => validateInitAdminPassword(input),
      },
    ]);

    // Create admin user directly in database (no daemon required)
    const db = await createDatabaseAsync({ url: `file:${dbPath}`, dialect: 'sqlite' });
    let userId: string;
    try {
      const user = await createUser(db, {
        email,
        password,
        name: username,
        role: 'admin',
      });
      userId = user.user_id;
    } finally {
      this.closeSQLiteDatabase(db);
    }
    this.log(`${chalk.green('   ✓')} Admin user created (${chalk.gray(email)})`);
    return userId;
  }
}
