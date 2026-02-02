/**
 * CLI entry point for executor
 *
 * Supports two modes:
 * 1. --stdin mode (new): JSON payload via stdin - preferred for all commands
 * 2. Legacy args mode: CLI arguments for backward compatibility (prompt only)
 *
 * The executor is ephemeral and task-scoped. Each subprocess executes exactly
 * one command and then exits. Communication with daemon is via Feathers/WebSocket.
 *
 * IMPERSONATION:
 * Impersonation is handled at spawn time by the daemon using buildSpawnArgs().
 * When the daemon spawns the executor with asUser, it uses `sudo su -` to run
 * the executor directly as the target user. The executor itself doesn't handle
 * impersonation - it's already running as the correct user.
 */

import { parseArgs } from 'node:util';

import { executeCommand, getRegisteredCommands } from './commands/index.js';
import { AgorExecutor } from './index.js';
import {
  type ExecutorPayload,
  ExecutorPayloadSchema,
  isPromptPayload,
  type PromptPayload,
} from './payload-types.js';

/**
 * Read all input from stdin
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Handle JSON-over-stdin mode
 */
async function handleStdinMode(options: { dryRun: boolean }): Promise<void> {
  // Read JSON from stdin
  const input = await readStdin();

  if (!input.trim()) {
    console.error('[executor] Error: Empty input received on stdin');
    console.error('[executor] Usage: echo \'{"command":"prompt",...}\' | agor-executor --stdin');
    process.exit(1);
  }

  let payload: ExecutorPayload;

  try {
    const parsed = JSON.parse(input);
    payload = ExecutorPayloadSchema.parse(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('[executor] Error: Invalid JSON input');
      console.error(`[executor] Details: ${error.message}`);
    } else if (error instanceof Error && error.name === 'ZodError') {
      console.error('[executor] Error: Invalid payload schema');
      console.error(`[executor] Details: ${error.message}`);
    } else {
      console.error('[executor] Error: Failed to parse payload');
      console.error(`[executor] Details: ${error}`);
    }
    process.exit(1);
  }

  console.log(`[executor] Received command: ${payload.command}`);

  // Special handling for prompt command - needs long-running WebSocket connection
  if (isPromptPayload(payload)) {
    await handlePromptPayload(payload, options);
    return;
  }

  // Special handling for zellij.attach - long-running PTY session
  // The executor must stay alive to stream PTY I/O
  if (payload.command === 'zellij.attach') {
    const result = await executeCommand(payload, { dryRun: options.dryRun });

    // Output result as JSON to stdout (for daemon to parse)
    console.log(JSON.stringify(result));

    if (!result.success) {
      process.exit(1);
    }

    // DON'T exit - stay alive to stream PTY I/O
    // The PTY onExit handler will call process.exit() when done
    console.log('[executor] Zellij attached, staying alive for PTY streaming...');
    return;
  }

  // All other commands go through the command router
  const result = await executeCommand(payload, { dryRun: options.dryRun });

  // Output result as JSON to stdout
  console.log(JSON.stringify(result));

  process.exit(result.success ? 0 : 1);
}

/**
 * Handle prompt command - requires special handling for long-running WebSocket
 */
async function handlePromptPayload(
  payload: PromptPayload,
  options: { dryRun: boolean }
): Promise<void> {
  if (options.dryRun) {
    console.log(
      JSON.stringify({
        success: true,
        data: {
          dryRun: true,
          command: 'prompt',
          sessionId: payload.params.sessionId,
          taskId: payload.params.taskId,
          tool: payload.params.tool,
          cwd: payload.params.cwd,
          envVars: payload.env ? Object.keys(payload.env).length : 0,
        },
      })
    );
    process.exit(0);
  }

  // =========================================================================
  // APPLY ENVIRONMENT VARIABLES FROM PAYLOAD
  //
  // When executor is spawned via impersonation (sudo su -), the parent
  // process environment is lost. The daemon passes env vars in the payload,
  // and we apply them here before starting the SDK.
  // =========================================================================
  if (payload.env && Object.keys(payload.env).length > 0) {
    console.log(`[executor] Applying ${Object.keys(payload.env).length} env vars from payload`);
    for (const [key, value] of Object.entries(payload.env)) {
      process.env[key] = value;
    }
  }

  // Validate tool using registry
  const { ToolRegistry, initializeToolRegistry } = await import('./handlers/sdk/tool-registry.js');
  await initializeToolRegistry();

  if (!ToolRegistry.has(payload.params.tool)) {
    console.error(`[executor] Invalid tool: ${payload.params.tool}`);
    console.error(`[executor] Valid tools: ${ToolRegistry.getAll().join(', ')}`);
    process.exit(1);
  }

  // Start executor in Feathers mode
  const executor = new AgorExecutor({
    sessionToken: payload.sessionToken,
    sessionId: payload.params.sessionId,
    taskId: payload.params.taskId,
    prompt: payload.params.prompt,
    tool: payload.params.tool,
    permissionMode: payload.params.permissionMode,
    daemonUrl: payload.daemonUrl || 'http://localhost:3030',
  });

  await executor.start();
}

/**
 * Handle legacy CLI arguments mode (backward compatibility)
 */
async function handleLegacyMode(values: {
  'session-token'?: string;
  'session-id'?: string;
  'task-id'?: string;
  prompt?: string;
  tool?: string;
  'permission-mode'?: string;
  'daemon-url'?: string;
}): Promise<void> {
  // Validate required arguments
  if (
    !values['session-token'] ||
    !values['session-id'] ||
    !values['task-id'] ||
    !values.prompt ||
    !values.tool
  ) {
    printUsage();
    process.exit(1);
  }

  // Validate tool using registry
  const { ToolRegistry, initializeToolRegistry } = await import('./handlers/sdk/tool-registry.js');
  await initializeToolRegistry();

  if (!ToolRegistry.has(values.tool as string)) {
    console.error(`Invalid tool: ${values.tool}`);
    console.error(`Valid tools: ${ToolRegistry.getAll().join(', ')}`);
    process.exit(1);
  }

  // Start executor in Feathers mode
  const executor = new AgorExecutor({
    sessionToken: values['session-token'] as string,
    sessionId: values['session-id'] as string,
    taskId: values['task-id'] as string,
    prompt: values.prompt as string,
    tool: values.tool as 'claude-code' | 'gemini' | 'codex' | 'opencode',
    permissionMode: (values['permission-mode'] as 'ask' | 'auto' | 'allow-all') || undefined,
    daemonUrl: (values['daemon-url'] as string) || 'http://localhost:3030',
  });

  await executor.start();
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.error('Usage: agor-executor [OPTIONS]');
  console.error('');
  console.error('Modes:');
  console.error('  --stdin                  Read JSON payload from stdin (recommended)');
  console.error('  [legacy args]            Use CLI arguments (backward compatible)');
  console.error('');
  console.error('Options:');
  console.error('  --stdin                  Read JSON payload from stdin');
  console.error('  --dry-run                Parse and validate without executing');
  console.error('');
  console.error('Legacy options (for prompt command only):');
  console.error('  --session-token <jwt>    JWT for Feathers authentication');
  console.error('  --session-id <id>        Session ID to execute prompt for');
  console.error('  --task-id <id>           Task ID created by daemon');
  console.error('  --prompt <text>          User prompt to execute');
  console.error('  --tool <name>            SDK tool (claude-code, gemini, codex, opencode)');
  console.error('  --permission-mode <mode> Permission mode (ask, auto, allow-all)');
  console.error('  --daemon-url <url>       Daemon WebSocket URL (default: http://localhost:3030)');
  console.error('');
  console.error('Supported commands (via --stdin):');
  for (const cmd of getRegisteredCommands()) {
    console.error(`  - ${cmd}`);
  }
  console.error('');
  console.error('Example (stdin mode):');
  console.error(
    '  echo \'{"command":"prompt","sessionToken":"...","params":{...}}\' | agor-executor --stdin'
  );
}

async function main() {
  // Register Handlebars helpers ONCE at startup (needed for template rendering)
  const { registerHandlebarsHelpers } = await import('@agor/core/templates/handlebars-helpers');
  registerHandlebarsHelpers();

  // Parse command-line arguments
  const { values } = parseArgs({
    options: {
      stdin: {
        type: 'boolean',
        default: false,
      },
      'dry-run': {
        type: 'boolean',
        default: false,
      },
      // Legacy args for backward compatibility
      'session-token': {
        type: 'string',
      },
      'session-id': {
        type: 'string',
      },
      'task-id': {
        type: 'string',
      },
      prompt: {
        type: 'string',
      },
      tool: {
        type: 'string',
      },
      'permission-mode': {
        type: 'string',
      },
      'daemon-url': {
        type: 'string',
      },
    },
    allowPositionals: false,
  });

  // Route to appropriate mode
  if (values.stdin) {
    await handleStdinMode({ dryRun: values['dry-run'] || false });
  } else if (values['session-token']) {
    // Legacy mode - use CLI arguments
    await handleLegacyMode(values);
  } else {
    printUsage();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[executor] Fatal error:', error);
  process.exit(1);
});
