/**
 * Command Executor Interface
 *
 * Abstraction for executing privileged Unix commands.
 * Supports two modes:
 * - DirectExecutor: Runs commands directly (for CLI running as root/sudo)
 * - SudoCliExecutor: Runs commands via `sudo agor admin` (for daemon)
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { exec, execSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Execute a command with stdin input using spawn
 *
 * @param cmd - Command to execute
 * @param args - Command arguments
 * @param input - Data to write to stdin
 * @returns Promise with stdout, stderr, and exit code
 */
function spawnWithInput(
  cmd: string,
  args: string[],
  input: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', reject);

    child.on('close', (code: number | null) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    // Write input to stdin and close it
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Result of command execution
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Options for command execution with stdin input
 */
export interface ExecWithInputOptions {
  /** Data to write to stdin */
  input: string;
}

/**
 * Command executor interface
 *
 * Implementations determine HOW commands are executed (directly, via sudo, etc.)
 */
export interface CommandExecutor {
  /**
   * Execute a command and return the result
   *
   * @param command - Shell command to execute
   * @returns Command result with stdout, stderr, and exit code
   * @throws Error if command fails (non-zero exit)
   */
  exec(command: string): Promise<CommandResult>;

  /**
   * Execute multiple commands sequentially
   *
   * Runs each command in order, stopping on first failure.
   * This is the secure alternative to using `sh -c 'cmd1 && cmd2 && cmd3'`.
   *
   * @param commands - Array of shell commands to execute
   * @returns Combined command result
   * @throws Error if any command fails (non-zero exit)
   */
  execAll(commands: string[]): Promise<CommandResult>;

  /**
   * Execute a command with stdin input
   *
   * SECURITY: Use this for passing sensitive data (passwords, secrets) to commands.
   * Data is passed via stdin, NOT as command-line arguments, so it won't be
   * visible in process listings (ps) or shell history.
   *
   * @param command - Shell command to execute (as array for execFile)
   * @param options - Options including stdin input
   * @returns Command result with stdout, stderr, and exit code
   * @throws Error if command fails (non-zero exit)
   */
  execWithInput(command: string[], options: ExecWithInputOptions): Promise<CommandResult>;

  /**
   * Execute a command synchronously
   *
   * @param command - Shell command to execute
   * @returns stdout as string
   * @throws Error if command fails
   */
  execSync(command: string): string;

  /**
   * Check if a command succeeds (exit code 0)
   *
   * @param command - Shell command to check
   * @returns true if exit code is 0, false otherwise
   */
  check(command: string): Promise<boolean>;
}

/**
 * Direct command executor
 *
 * Executes commands directly via shell. Use when running as root.
 * Typically used by CLI admin commands when running with root privileges.
 */
export class DirectExecutor implements CommandExecutor {
  async exec(command: string): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execAsync(command);
      return { stdout, stderr, exitCode: 0 };
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        exitCode: err.code || 1,
      };
    }
  }

  async execAll(commands: string[]): Promise<CommandResult> {
    let combinedStdout = '';
    let combinedStderr = '';
    for (const command of commands) {
      const result = await this.exec(command);
      combinedStdout += result.stdout;
      combinedStderr += result.stderr;
      if (result.exitCode !== 0) {
        return { stdout: combinedStdout, stderr: combinedStderr, exitCode: result.exitCode };
      }
    }
    return { stdout: combinedStdout, stderr: combinedStderr, exitCode: 0 };
  }

  async execWithInput(command: string[], options: ExecWithInputOptions): Promise<CommandResult> {
    try {
      const [cmd, ...args] = command;
      return await spawnWithInput(cmd, args, options.input);
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.code || 1,
      };
    }
  }

  execSync(command: string): string {
    return execSync(command, { encoding: 'utf-8' });
  }

  async check(command: string): Promise<boolean> {
    try {
      await execAsync(command);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Sudo direct command executor
 *
 * Executes commands with sudo prefix. Use when running as unprivileged user
 * with passwordless sudo access (e.g., Docker dev environment).
 */
export class SudoDirectExecutor implements CommandExecutor {
  async exec(command: string): Promise<CommandResult> {
    // CRITICAL: Use -n (non-interactive) to prevent sudo from blocking on password prompt
    // Without -n, sudo opens /dev/tty and blocks forever if password required,
    // which can freeze the entire Node.js event loop and even affect system TTY resources
    const sudoCommand = `sudo -n ${command}`;
    console.log(`[SudoDirectExecutor] Executing: ${sudoCommand}`);
    try {
      const { stdout, stderr } = await execAsync(sudoCommand);
      return { stdout, stderr, exitCode: 0 };
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      console.error(`[SudoDirectExecutor] Command failed: ${sudoCommand}`, err.message);
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.code || 1,
      };
    }
  }

  async execAll(commands: string[]): Promise<CommandResult> {
    let combinedStdout = '';
    let combinedStderr = '';
    for (const command of commands) {
      const result = await this.exec(command);
      combinedStdout += result.stdout;
      combinedStderr += result.stderr;
      if (result.exitCode !== 0) {
        return { stdout: combinedStdout, stderr: combinedStderr, exitCode: result.exitCode };
      }
    }
    return { stdout: combinedStdout, stderr: combinedStderr, exitCode: 0 };
  }

  async execWithInput(command: string[], options: ExecWithInputOptions): Promise<CommandResult> {
    // Prepend 'sudo' and '-n' to the command array
    const sudoCommand = ['sudo', '-n', ...command];
    const cmdStr = sudoCommand.join(' ');
    console.log(`[SudoDirectExecutor] Executing with input: ${cmdStr}`);
    try {
      const [cmd, ...args] = sudoCommand;
      return await spawnWithInput(cmd, args, options.input);
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      console.error(`[SudoDirectExecutor] Command with input failed: ${cmdStr}`, err.message);
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.code || 1,
      };
    }
  }

  execSync(command: string): string {
    // CRITICAL: Use -n (non-interactive) - see async exec() comment for details
    const sudoCommand = `sudo -n ${command}`;
    console.log(`[SudoDirectExecutor] Executing (sync): ${sudoCommand}`);
    return execSync(sudoCommand, { encoding: 'utf-8' });
  }

  async check(command: string): Promise<boolean> {
    const result = await this.exec(command);
    return result.exitCode === 0;
  }
}

/**
 * Sudo CLI executor configuration
 */
export interface SudoCliExecutorConfig {
  /** Path to agor CLI binary (default: 'agor') */
  cliPath?: string;

  /** Use sudo prefix (default: true) */
  useSudo?: boolean;
}

/**
 * Sudo CLI command executor
 *
 * Executes privileged commands via `sudo agor admin <command>`.
 * Use when running as unprivileged daemon user.
 *
 * Security: Sudoers should be configured to only allow specific admin commands:
 * ```
 * agor ALL=(ALL) NOPASSWD: /usr/local/bin/agor admin *
 * ```
 */
export class SudoCliExecutor implements CommandExecutor {
  private cliPath: string;
  private useSudo: boolean;

  constructor(config: SudoCliExecutorConfig = {}) {
    this.cliPath = config.cliPath || 'agor';
    this.useSudo = config.useSudo ?? true;
  }

  /**
   * Build the full command with sudo and CLI prefix
   *
   * CRITICAL: Uses -n flag to prevent password prompts that freeze the system
   */
  private buildCommand(adminCommand: string, args: string[] = []): string {
    const sudo = this.useSudo ? 'sudo -n' : '';
    const argsStr = args.length > 0 ? ` ${args.join(' ')}` : '';
    return `${sudo} ${this.cliPath} admin ${adminCommand}${argsStr}`.trim();
  }

  async exec(command: string): Promise<CommandResult> {
    // For SudoCliExecutor, the "command" is the admin subcommand
    // e.g., "create-worktree-group --worktree-id abc123"
    const fullCommand = this.buildCommand(command);

    console.log(`[SudoCliExecutor] Executing: ${fullCommand}`);

    try {
      const { stdout, stderr } = await execAsync(fullCommand);
      if (stderr) {
        console.warn(`[SudoCliExecutor] stderr: ${stderr}`);
      }
      return { stdout, stderr, exitCode: 0 };
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      console.error(`[SudoCliExecutor] Command failed: ${fullCommand}`, err.message);
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.code || 1,
      };
    }
  }

  async execWithInput(_command: string[], _options: ExecWithInputOptions): Promise<CommandResult> {
    // SudoCliExecutor routes through CLI admin commands, which don't support stdin input.
    // Password sync should use DirectExecutor or SudoDirectExecutor instead.
    throw new Error(
      'execWithInput is not supported by SudoCliExecutor. ' +
        'Use DirectExecutor or SudoDirectExecutor for commands requiring stdin input.'
    );
  }

  execSync(command: string): string {
    const fullCommand = this.buildCommand(command);
    console.log(`[SudoCliExecutor] Executing (sync): ${fullCommand}`);
    return execSync(fullCommand, { encoding: 'utf-8' });
  }

  async execAll(commands: string[]): Promise<CommandResult> {
    let combinedStdout = '';
    let combinedStderr = '';
    for (const command of commands) {
      const result = await this.exec(command);
      combinedStdout += result.stdout;
      combinedStderr += result.stderr;
      if (result.exitCode !== 0) {
        return { stdout: combinedStdout, stderr: combinedStderr, exitCode: result.exitCode };
      }
    }
    return { stdout: combinedStdout, stderr: combinedStderr, exitCode: 0 };
  }

  async check(command: string): Promise<boolean> {
    const result = await this.exec(command);
    return result.exitCode === 0;
  }
}

/**
 * No-op executor for testing or disabled mode
 *
 * Logs commands but doesn't execute them.
 */
export class NoOpExecutor implements CommandExecutor {
  async exec(command: string): Promise<CommandResult> {
    console.log(`[NoOpExecutor] Would execute: ${command}`);
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async execAll(commands: string[]): Promise<CommandResult> {
    for (const command of commands) {
      console.log(`[NoOpExecutor] Would execute: ${command}`);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async execWithInput(command: string[], _options: ExecWithInputOptions): Promise<CommandResult> {
    console.log(`[NoOpExecutor] Would execute with input: ${command.join(' ')}`);
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  execSync(command: string): string {
    console.log(`[NoOpExecutor] Would execute (sync): ${command}`);
    return '';
  }

  async check(_command: string): Promise<boolean> {
    return true;
  }
}

/**
 * Logging wrapper for any executor
 *
 * Adds consistent logging and optional dry-run support to any executor.
 * Use this to add observability without modifying the underlying executor.
 */
export class LoggingExecutor implements CommandExecutor {
  private delegate: CommandExecutor;
  private prefix: string;
  private verbose: boolean;

  constructor(delegate: CommandExecutor, options: { prefix?: string; verbose?: boolean } = {}) {
    this.delegate = delegate;
    this.prefix = options.prefix || 'LoggingExecutor';
    this.verbose = options.verbose ?? false;
  }

  async exec(command: string): Promise<CommandResult> {
    console.log(`[${this.prefix}] Executing: ${command}`);
    const result = await this.delegate.exec(command);
    if (this.verbose || result.exitCode !== 0) {
      if (result.stdout.trim()) console.log(`[${this.prefix}] stdout: ${result.stdout.trim()}`);
      if (result.stderr.trim()) console.log(`[${this.prefix}] stderr: ${result.stderr.trim()}`);
    }
    if (result.exitCode !== 0) {
      console.log(`[${this.prefix}] Exit code: ${result.exitCode}`);
    }
    return result;
  }

  async execAll(commands: string[]): Promise<CommandResult> {
    console.log(`[${this.prefix}] Executing ${commands.length} command(s):`);
    for (const cmd of commands) {
      console.log(`[${this.prefix}]   → ${cmd}`);
    }
    const result = await this.delegate.execAll(commands);
    if (this.verbose || result.exitCode !== 0) {
      if (result.stdout.trim()) console.log(`[${this.prefix}] stdout: ${result.stdout.trim()}`);
      if (result.stderr.trim()) console.log(`[${this.prefix}] stderr: ${result.stderr.trim()}`);
    }
    if (result.exitCode !== 0) {
      console.log(`[${this.prefix}] Exit code: ${result.exitCode}`);
    }
    return result;
  }

  async execWithInput(command: string[], options: ExecWithInputOptions): Promise<CommandResult> {
    const cmdStr = command.join(' ');
    console.log(`[${this.prefix}] Executing with stdin: ${cmdStr}`);
    if (this.verbose) {
      // Don't log sensitive input, just indicate it exists
      console.log(`[${this.prefix}]   (input: ${options.input.length} bytes)`);
    }
    const result = await this.delegate.execWithInput(command, options);
    if (this.verbose || result.exitCode !== 0) {
      if (result.stdout.trim()) console.log(`[${this.prefix}] stdout: ${result.stdout.trim()}`);
      if (result.stderr.trim()) console.log(`[${this.prefix}] stderr: ${result.stderr.trim()}`);
    }
    if (result.exitCode !== 0) {
      console.log(`[${this.prefix}] Exit code: ${result.exitCode}`);
    }
    return result;
  }

  execSync(command: string): string {
    console.log(`[${this.prefix}] Executing (sync): ${command}`);
    const result = this.delegate.execSync(command);
    if (this.verbose && result.trim()) {
      console.log(`[${this.prefix}] stdout: ${result.trim()}`);
    }
    return result;
  }

  async check(command: string): Promise<boolean> {
    if (this.verbose) {
      console.log(`[${this.prefix}] Checking: ${command}`);
    }
    const result = await this.delegate.check(command);
    if (this.verbose) {
      console.log(`[${this.prefix}] Check result: ${result}`);
    }
    return result;
  }
}

/**
 * Error thrown when a command fails (non-zero exit code)
 */
export class CommandError extends Error {
  readonly result: CommandResult;
  readonly command: string;

  constructor(command: string, result: CommandResult) {
    const msg = result.stderr.trim() || `Command failed with exit code ${result.exitCode}`;
    super(msg);
    this.name = 'CommandError';
    this.command = command;
    this.result = result;
  }
}

/**
 * Throwing executor wrapper
 *
 * Wraps any executor to throw on non-zero exit codes.
 * This enforces the CommandExecutor interface contract that failures throw.
 */
export class ThrowingExecutor implements CommandExecutor {
  private delegate: CommandExecutor;

  constructor(delegate: CommandExecutor) {
    this.delegate = delegate;
  }

  async exec(command: string): Promise<CommandResult> {
    const result = await this.delegate.exec(command);
    if (result.exitCode !== 0) {
      throw new CommandError(command, result);
    }
    return result;
  }

  async execAll(commands: string[]): Promise<CommandResult> {
    const result = await this.delegate.execAll(commands);
    if (result.exitCode !== 0) {
      throw new CommandError(commands.join(' && '), result);
    }
    return result;
  }

  async execWithInput(command: string[], options: ExecWithInputOptions): Promise<CommandResult> {
    const result = await this.delegate.execWithInput(command, options);
    if (result.exitCode !== 0) {
      throw new CommandError(command.join(' '), result);
    }
    return result;
  }

  execSync(command: string): string {
    // execSync already throws on failure
    return this.delegate.execSync(command);
  }

  async check(command: string): Promise<boolean> {
    return this.delegate.check(command);
  }
}

/**
 * Dry-run executor wrapper
 *
 * Wraps any executor to provide dry-run functionality.
 * In dry-run mode, logs what would be executed without actually running.
 * Check operations still run to provide accurate state information.
 */
export class DryRunExecutor implements CommandExecutor {
  private delegate: CommandExecutor;
  private dryRun: boolean;
  private prefix: string;

  constructor(delegate: CommandExecutor, options: { dryRun?: boolean; prefix?: string } = {}) {
    this.delegate = delegate;
    this.dryRun = options.dryRun ?? true;
    this.prefix = options.prefix || 'DryRun';
  }

  async exec(command: string): Promise<CommandResult> {
    if (this.dryRun) {
      console.log(`[${this.prefix}] Would execute: ${command}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return this.delegate.exec(command);
  }

  async execAll(commands: string[]): Promise<CommandResult> {
    if (this.dryRun) {
      for (const cmd of commands) {
        console.log(`[${this.prefix}] Would execute: ${cmd}`);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return this.delegate.execAll(commands);
  }

  async execWithInput(command: string[], options: ExecWithInputOptions): Promise<CommandResult> {
    if (this.dryRun) {
      console.log(`[${this.prefix}] Would execute with stdin: ${command.join(' ')}`);
      console.log(`[${this.prefix}]   (input: ${options.input.length} bytes)`);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return this.delegate.execWithInput(command, options);
  }

  execSync(command: string): string {
    if (this.dryRun) {
      console.log(`[${this.prefix}] Would execute (sync): ${command}`);
      return '';
    }
    return this.delegate.execSync(command);
  }

  async check(command: string): Promise<boolean> {
    // Check operations always run - they're read-only and needed for accurate dry-run output
    return this.delegate.check(command);
  }
}

/**
 * Options for creating an executor
 */
export interface CreateExecutorOptions extends SudoCliExecutorConfig {
  /** Enable dry-run mode (log but don't execute) */
  dryRun?: boolean;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Custom prefix for log messages */
  logPrefix?: string;
}

/**
 * Create appropriate executor based on configuration
 *
 * @param mode - Execution mode:
 *   - 'direct': Run commands directly (requires root)
 *   - 'sudo-direct': Run commands with sudo prefix (for unprivileged user with passwordless sudo)
 *   - 'sudo-cli': Run commands via `sudo agor admin` (requires agor CLI installed)
 *   - 'noop': Log commands but don't execute (for testing)
 * @param options - Configuration options including dry-run and verbose flags
 */
export function createExecutor(
  mode: 'direct' | 'sudo-direct' | 'sudo-cli' | 'noop',
  options: CreateExecutorOptions = {}
): CommandExecutor {
  let executor: CommandExecutor;

  switch (mode) {
    case 'direct':
      executor = new DirectExecutor();
      break;
    case 'sudo-direct':
      executor = new SudoDirectExecutor();
      break;
    case 'sudo-cli':
      executor = new SudoCliExecutor(options);
      break;
    case 'noop':
      executor = new NoOpExecutor();
      break;
    default:
      throw new Error(`Unknown executor mode: ${mode}`);
  }

  // Wrap with dry-run if requested
  if (options.dryRun) {
    executor = new DryRunExecutor(executor, { prefix: options.logPrefix });
  }
  // Wrap with logging if verbose (and not already dry-run which logs anyway)
  else if (options.verbose) {
    executor = new LoggingExecutor(executor, {
      prefix: options.logPrefix,
      verbose: true,
    });
  }

  return executor;
}

/**
 * Create an executor for CLI admin commands
 *
 * This is a convenience function for CLI commands that provides:
 * - Direct execution (CLI runs as root via sudo)
 * - Throws on command failure (non-zero exit code)
 * - Dry-run support via --dry-run flag
 * - Verbose logging via --verbose flag
 *
 * @param flags - CLI flags object with dry-run and verbose options
 */
export function createAdminExecutor(
  flags: { 'dry-run'?: boolean; verbose?: boolean } = {}
): CommandExecutor {
  let executor: CommandExecutor = new DirectExecutor();

  // Wrap with ThrowingExecutor to enforce failure handling
  executor = new ThrowingExecutor(executor);

  // Wrap with dry-run if requested
  if (flags['dry-run']) {
    executor = new DryRunExecutor(executor, { prefix: 'Admin' });
  }
  // Wrap with logging if verbose (and not already dry-run which logs anyway)
  else if (flags.verbose) {
    executor = new LoggingExecutor(executor, { prefix: 'Admin', verbose: true });
  }

  return executor;
}
