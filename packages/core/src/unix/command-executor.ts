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
 * Create appropriate executor based on configuration
 *
 * @param mode - Execution mode:
 *   - 'direct': Run commands directly (requires root)
 *   - 'sudo-direct': Run commands with sudo prefix (for unprivileged user with passwordless sudo)
 *   - 'sudo-cli': Run commands via `sudo agor admin` (requires agor CLI installed)
 *   - 'noop': Log commands but don't execute (for testing)
 * @param config - Configuration for sudo CLI executor
 */
export function createExecutor(
  mode: 'direct' | 'sudo-direct' | 'sudo-cli' | 'noop',
  config?: SudoCliExecutorConfig
): CommandExecutor {
  switch (mode) {
    case 'direct':
      return new DirectExecutor();
    case 'sudo-direct':
      return new SudoDirectExecutor();
    case 'sudo-cli':
      return new SudoCliExecutor(config);
    case 'noop':
      return new NoOpExecutor();
    default:
      throw new Error(`Unknown executor mode: ${mode}`);
  }
}
