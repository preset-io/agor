/**
 * Shell utilities for spawning interactive shells
 */

import { type ChildProcess, spawn } from 'node:child_process';

export interface SpawnShellOptions {
  /**
   * Working directory for the shell
   */
  cwd: string;

  /**
   * Additional environment variables to set
   */
  env?: Record<string, string>;

  /**
   * Callback when shell exits
   */
  onExit?: (code: number | null) => void;

  /**
   * Callback on error
   */
  onError?: (error: Error) => void;
}

/**
 * Spawn an interactive shell in the specified directory.
 *
 * This will:
 * - Use the user's preferred shell ($SHELL)
 * - Run in interactive mode (loads .zshrc, .bashrc, etc.)
 * - Inherit stdio for full interactivity
 * - Preserve all environment variables
 *
 * @param options - Shell spawn options
 * @returns The spawned child process
 */
export function spawnInteractiveShell(options: SpawnShellOptions): ChildProcess {
  const { cwd, env = {}, onExit, onError } = options;

  // Get user's preferred shell
  const shell = process.env.SHELL || '/bin/bash';

  // Spawn shell in interactive mode (-i flag)
  // This ensures it loads the user's config files (.zshrc, .bashrc, etc.)
  const shellProcess = spawn(shell, ['-i'], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...env,
    },
  });

  // Handle exit
  if (onExit) {
    shellProcess.on('exit', onExit);
  }

  // Handle errors
  if (onError) {
    shellProcess.on('error', onError);
  }

  return shellProcess;
}
