/**
 * Command Router - Routes ExecutorPayload commands to appropriate handlers
 *
 * Each command handler is responsible for:
 * 1. Connecting to daemon via Feathers (if needed)
 * 2. Executing the operation
 * 3. Returning an ExecutorResult
 */

import type { ExecutorPayload, ExecutorResult, PromptPayload } from '../payload-types.js';
import { handleEnvironmentLifecycle, handleEnvironmentLogs } from './environment.js';
import {
  handleBranchAgorYmlExport,
  handleBranchAgorYmlImport,
  handleBranchFilesList,
  handleBranchInspect,
  handleGitBranchAdd,
  handleGitBranchClean,
  handleGitBranchRemove,
  handleGitClone,
  handleGitRepoDelete,
  handleGitRepoRealignOrigin,
} from './git.js';
import {
  handleUnixSyncBoard,
  handleUnixSyncBranch,
  handleUnixSyncRepo,
  handleUnixSyncUser,
} from './unix.js';
import { handleZellijAttach, handleZellijTab } from './zellij.js';

export interface CommandOptions {
  /** Dry run mode - don't actually execute */
  dryRun?: boolean;
}

/**
 * Command handler function signature
 */
type CommandHandler<T extends ExecutorPayload> = (
  payload: T,
  options: CommandOptions
) => Promise<ExecutorResult>;

/**
 * Registry of command handlers
 */
const commandHandlers: Map<string, CommandHandler<ExecutorPayload>> = new Map();

/**
 * Register a command handler
 */
export function registerCommand<T extends ExecutorPayload>(
  command: string,
  handler: CommandHandler<T>
): void {
  commandHandlers.set(command, handler as CommandHandler<ExecutorPayload>);
}

/**
 * Execute a command based on the payload
 */
export async function executeCommand(
  payload: ExecutorPayload,
  options: CommandOptions = {}
): Promise<ExecutorResult> {
  const handler = commandHandlers.get(payload.command);

  if (!handler) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `Unknown command: ${payload.command}`,
        details: {
          supportedCommands: Array.from(commandHandlers.keys()),
        },
      },
    };
  }

  try {
    return await handler(payload, options);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    return {
      success: false,
      error: {
        code: 'COMMAND_FAILED',
        message: errorMessage,
        details: {
          command: payload.command,
          stack: errorStack,
        },
      },
    };
  }
}

/**
 * Check if a command is registered
 */
export function hasCommand(command: string): boolean {
  return commandHandlers.has(command);
}

/**
 * Get list of registered commands
 */
export function getRegisteredCommands(): string[] {
  return Array.from(commandHandlers.keys());
}

// ═══════════════════════════════════════════════════════════
// Command Handler Implementations
// ═══════════════════════════════════════════════════════════

/**
 * Prompt command handler - executes agent SDK
 *
 * This is the existing behavior, now wrapped in the new command structure.
 * The actual execution happens through AgorExecutor.
 */
async function handlePromptCommand(
  payload: PromptPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'prompt',
        sessionId: payload.params.sessionId,
        taskId: payload.params.taskId,
        tool: payload.params.tool,
      },
    };
  }

  // For prompt command, we delegate to the existing AgorExecutor
  // The CLI handles this specially since it needs to stay running
  // and stream results via WebSocket
  return {
    success: true,
    data: {
      delegateToExecutor: true,
      message: 'Prompt command should be handled by AgorExecutor',
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Register All Commands
// ═══════════════════════════════════════════════════════════

registerCommand('prompt', handlePromptCommand);
registerCommand('git.clone', handleGitClone);
registerCommand('git.branch.add', handleGitBranchAdd);
registerCommand('git.branch.remove', handleGitBranchRemove);
registerCommand('git.branch.clean', handleGitBranchClean);
registerCommand('branch.files.list', handleBranchFilesList);
registerCommand('branch.inspect', handleBranchInspect);
registerCommand('branch.agor-yml.import', handleBranchAgorYmlImport);
registerCommand('branch.agor-yml.export', handleBranchAgorYmlExport);
registerCommand('environment.lifecycle', handleEnvironmentLifecycle);
registerCommand('environment.logs', handleEnvironmentLogs);
registerCommand('git.repo.realign-origin', handleGitRepoRealignOrigin);
registerCommand('git.repo.delete', handleGitRepoDelete);
registerCommand('unix.sync-repo', handleUnixSyncRepo);
registerCommand('unix.sync-branch', handleUnixSyncBranch);
registerCommand('unix.sync-board', handleUnixSyncBoard);
registerCommand('unix.sync-user', handleUnixSyncUser);
registerCommand('zellij.attach', handleZellijAttach);
registerCommand('zellij.tab', handleZellijTab);
