/**
 * Command Router - Routes ExecutorPayload commands to appropriate handlers
 *
 * Each command handler is responsible for:
 * 1. Connecting to daemon via Feathers (if needed)
 * 2. Executing the operation
 * 3. Returning an ExecutorResult
 */

import type {
  ExecutorPayload,
  ExecutorResult,
  GitClonePayload,
  GitWorktreeAddPayload,
  GitWorktreeRemovePayload,
  PromptPayload,
  ZellijAttachPayload,
} from '../payload-types.js';

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

/**
 * Git clone command handler - clones repository with Unix setup
 *
 * Future implementation (Phase 3)
 */
async function handleGitCloneCommand(
  payload: GitClonePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.clone',
        url: payload.params.url,
        outputPath: payload.params.outputPath,
        branch: payload.params.branch,
        bare: payload.params.bare,
      },
    };
  }

  // TODO: Phase 3 implementation
  return {
    success: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'git.clone command is not yet implemented (Phase 3)',
    },
  };
}

/**
 * Git worktree add command handler - creates worktree with Unix setup
 *
 * Future implementation (Phase 3)
 */
async function handleGitWorktreeAddCommand(
  payload: GitWorktreeAddPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.worktree.add',
        repoPath: payload.params.repoPath,
        worktreeName: payload.params.worktreeName,
        worktreePath: payload.params.worktreePath,
        branch: payload.params.branch,
        createBranch: payload.params.createBranch,
      },
    };
  }

  // TODO: Phase 3 implementation
  return {
    success: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'git.worktree.add command is not yet implemented (Phase 3)',
    },
  };
}

/**
 * Git worktree remove command handler - removes worktree and cleans up Unix resources
 *
 * Future implementation (Phase 3)
 */
async function handleGitWorktreeRemoveCommand(
  payload: GitWorktreeRemovePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.worktree.remove',
        worktreePath: payload.params.worktreePath,
        force: payload.params.force,
      },
    };
  }

  // TODO: Phase 3 implementation
  return {
    success: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'git.worktree.remove command is not yet implemented (Phase 3)',
    },
  };
}

/**
 * Zellij attach command handler - attaches to or creates Zellij session
 *
 * Future implementation (Phase 5)
 */
async function handleZellijAttachCommand(
  payload: ZellijAttachPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'zellij.attach',
        sessionName: payload.params.sessionName,
        cwd: payload.params.cwd,
        tabName: payload.params.tabName,
        create: payload.params.create,
      },
    };
  }

  // TODO: Phase 5 implementation
  return {
    success: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'zellij.attach command is not yet implemented (Phase 5)',
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Register All Commands
// ═══════════════════════════════════════════════════════════

registerCommand('prompt', handlePromptCommand);
registerCommand('git.clone', handleGitCloneCommand);
registerCommand('git.worktree.add', handleGitWorktreeAddCommand);
registerCommand('git.worktree.remove', handleGitWorktreeRemoveCommand);
registerCommand('zellij.attach', handleZellijAttachCommand);
