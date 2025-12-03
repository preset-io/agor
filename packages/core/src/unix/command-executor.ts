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

import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Result of command execution
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
 * Executes commands directly via shell. Use when running as root/sudo.
 * Typically used by CLI admin commands.
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
   */
  private buildCommand(adminCommand: string, args: string[] = []): string {
    const sudo = this.useSudo ? 'sudo' : '';
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

  execSync(command: string): string {
    const fullCommand = this.buildCommand(command);
    console.log(`[SudoCliExecutor] Executing (sync): ${fullCommand}`);
    return execSync(fullCommand, { encoding: 'utf-8' });
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

  execSync(command: string): string {
    console.log(`[NoOpExecutor] Would execute (sync): ${command}`);
    return '';
  }

  async check(_command: string): Promise<boolean> {
    return true;
  }
}

/**
 * Create appropriate executor based on configuration
 *
 * @param mode - Execution mode
 * @param config - Configuration for sudo executor
 */
export function createExecutor(
  mode: 'direct' | 'sudo' | 'noop',
  config?: SudoCliExecutorConfig
): CommandExecutor {
  switch (mode) {
    case 'direct':
      return new DirectExecutor();
    case 'sudo':
      return new SudoCliExecutor(config);
    case 'noop':
      return new NoOpExecutor();
    default:
      throw new Error(`Unknown executor mode: ${mode}`);
  }
}
