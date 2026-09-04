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
 * The executor contains no host-user impersonation logic. An external
 * delegated launcher may select its own execution identity before startup.
 */

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { ExecutorCommandResult } from '@agor/core/executor-protocol';

import {
  executeCommand,
  executeInteractiveCommand,
  getRegisteredCommands,
} from './commands/index.js';
import { ExecutorResponsePublisher } from './executor-response.js';
import { initializeToolRegistry, type Tool, ToolRegistry } from './handlers/sdk/tool-registry.js';
import { AgorExecutor } from './index.js';
import {
  type ExecutorPayload,
  ExecutorPayloadSchema,
  isPromptPayload,
  type PromptPayload,
} from './payload-types.js';
import { applyPromptPayloadEnvironment } from './prompt-payload-env.js';

const DEBUG_EXECUTOR_CLI =
  process.env.AGOR_DEBUG_EXECUTOR_CLI === '1' || process.env.DEBUG?.includes('executor-cli');

function executorCliDebug(...args: unknown[]): void {
  if (DEBUG_EXECUTOR_CLI) {
    console.debug(...args);
  }
}

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

async function finishExecutorCommand(
  result: ExecutorCommandResult,
  publisher?: ExecutorResponsePublisher
): Promise<never> {
  const code = result.success ? 0 : 1;
  if (publisher) {
    try {
      await publisher.final(result);
    } catch {
      console.error('[executor] Failed to deliver executor response');
      process.exit(1);
    }
  }
  process.exit(code);
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

  executorCliDebug(`[executor] Received command: ${payload.command}`);
  const publisher =
    payload.executorMode === 'request' && payload.executorResponse
      ? new ExecutorResponsePublisher(payload.executorResponse)
      : undefined;

  // Special handling for prompt command - needs long-running WebSocket connection
  if (isPromptPayload(payload)) {
    if (publisher) {
      await finishExecutorCommand(
        {
          success: false,
          error: {
            code: 'EXECUTOR_REQUEST_MODE_UNSUPPORTED',
            message: 'Prompt execution is autonomous and does not return a request response',
          },
        },
        publisher
      );
    }
    await handlePromptPayload(payload, options);
    return;
  }

  // Special handling for zellij.attach - long-running PTY session
  // The executor must stay alive to stream PTY I/O
  if (payload.command === 'zellij.attach') {
    if (publisher) {
      await finishExecutorCommand(
        {
          success: false,
          error: {
            code: 'EXECUTOR_REQUEST_MODE_UNSUPPORTED',
            message: 'Zellij attachment is autonomous and has no terminal request payload',
          },
        },
        publisher
      );
    }
    const result = await executeCommand(payload, { dryRun: options.dryRun });

    if (!result.success) {
      await finishExecutorCommand(result, publisher);
    }

    // DON'T exit - stay alive to stream PTY I/O
    // The PTY onExit handler will call process.exit() when done
    console.log('[executor] Zellij attached, staying alive for PTY streaming...');
    return;
  }

  // All other commands go through the command router
  const result = await executeCommand(payload, { dryRun: options.dryRun });
  await finishExecutorCommand(result, publisher);
}

/**
 * Bounded JSON-lines transport for commands that require intermediate events
 * or one or more command-owned control frames.
 */
async function handleInteractiveCommandMode(options: { dryRun: boolean }): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const iterator = lines[Symbol.asyncIterator]();
  let publisher: ExecutorResponsePublisher | undefined;
  try {
    const first = await iterator.next();
    if (first.done || !first.value.trim()) throw new Error('missing payload');
    const payload = ExecutorPayloadSchema.parse(JSON.parse(first.value));
    if (payload.executorMode !== 'request' || !payload.executorResponse) {
      throw new Error('interactive commands require request mode');
    }
    publisher = new ExecutorResponsePublisher(payload.executorResponse);
    const result = await executeInteractiveCommand(
      payload,
      { dryRun: options.dryRun },
      {
        emit: (event) => publisher?.emit(event),
        async read() {
          const next = await iterator.next();
          if (next.done) throw new Error('Interactive command input closed');
          return JSON.parse(next.value) as unknown;
        },
      }
    );
    await finishExecutorCommand(result, publisher);
  } catch {
    const result = {
      success: false,
      error: {
        code: 'INTERACTIVE_COMMAND_PROTOCOL_INVALID',
        message: 'Interactive executor input was invalid.',
      },
    } satisfies ExecutorCommandResult;
    if (publisher) await finishExecutorCommand(result, publisher);
    console.error('[executor] Interactive command protocol invalid');
    process.exit(1);
  } finally {
    lines.close();
  }
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
      `[executor] Dry run validated prompt payload for ${payload.params.tool} ` +
        `(${payload.env ? Object.keys(payload.env).length : 0} environment variables)`
    );
    process.exitCode = 0;
    return;
  }

  // =========================================================================
  // APPLY ENVIRONMENT VARIABLES FROM PAYLOAD
  //
  // External launchers may intentionally replace the parent environment. The
  // daemon passes approved env vars in the payload and we apply them here.
  // =========================================================================
  if (payload.env && Object.keys(payload.env).length > 0) {
    // System-identity / process-hijacking vars must come from the pod, never
    // from the daemon-built payload. Under HA the daemon forwards its own
    // HOME (=/home/agor); applying it would override the ephemeral pod's mounted
    // per-user HOME (…/home/<segment>), so the agentic-tool CLI would look for
    // its ~/.claude session state in the wrong (ephemeral) home and every
    // session resume fails with "No conversation found".
    // Loader-injection families are denied by prefix so no variant slips through
    // (LD_PRELOAD, LD_AUDIT, LD_PROFILE, LD_DEBUG, DYLD_INSERT_LIBRARIES, …).
    const { applied, rejected, identityDenied } = applyPromptPayloadEnvironment(
      payload.env,
      process.env,
      (key) => {
        // Log key only — never the value, which is attacker-controlled.
        executorCliDebug(`[executor] Rejected invalid env var from payload: ${key}`);
      }
    );
    executorCliDebug(
      `[executor] Applying ${applied.length} env vars from payload` +
        (rejected.length > 0 ? ` (${rejected.length} invalid)` : '') +
        (identityDenied.length > 0 ? ` (identity-denied: ${identityDenied.join(',')})` : '')
    );
  }

  // Validate tool using registry
  // Select the requested tool before loading handlers. Built-in workloads must
  // not be rejected by the provider-only default registry or eagerly load
  // provider SDKs they deliberately do not use.
  await initializeToolRegistry(payload.params.tool);

  if (!ToolRegistry.has(payload.params.tool)) {
    console.error(`[executor] Invalid tool: ${payload.params.tool}`);
    console.error(`[executor] Valid tools: ${ToolRegistry.getAll().join(', ')}`);
    process.exit(1);
  }

  // Seed DAEMON_URL so executor-local getDaemonUrl() works regardless of
  // whether spawn-executor.ts already set it. In stdin-via-daemon mode the
  // env var is already populated by spawn-executor.ts; in `agor-executor
  // --stdin < payload.json` debug runs the payload's daemonUrl is the
  // only source. The executor never reads config.yaml for this — see
  // packages/executor/src/config.ts.
  const resolvedDaemonUrl = payload.daemonUrl || 'http://localhost:3030';
  process.env.DAEMON_URL = resolvedDaemonUrl;

  // Start executor in Feathers mode
  const executor = new AgorExecutor({
    sessionToken: payload.sessionToken,
    sessionId: payload.params.sessionId,
    taskId: payload.params.taskId,
    prompt: payload.params.prompt,
    workspaceCwd: payload.params.cwd,
    tool: payload.params.tool,
    permissionMode: payload.params.permissionMode,
    daemonUrl: resolvedDaemonUrl,
    messageSource: payload.params.messageSource,
    promptOrigin: payload.params.promptOrigin,
    agenticToolContext: payload.agenticToolContext,
    resolvedConfig: payload.resolvedConfig,
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

  // Validate only the requested tool. This keeps the built-in workload path
  // provider-free and gives it the same registration behavior as stdin mode.
  const tool = values.tool as Tool;
  await initializeToolRegistry(tool);

  if (!ToolRegistry.has(tool)) {
    console.error(`Invalid tool: ${tool}`);
    console.error(`Valid tools: ${ToolRegistry.getAll().join(', ')}`);
    process.exit(1);
  }

  // Seed DAEMON_URL so executor-local getDaemonUrl() works in the legacy
  // CLI flow too (no parent process to set it). See config.ts.
  const resolvedDaemonUrl = (values['daemon-url'] as string) || 'http://localhost:3030';
  process.env.DAEMON_URL = resolvedDaemonUrl;

  // Start executor in Feathers mode
  const executor = new AgorExecutor({
    sessionToken: values['session-token'] as string,
    sessionId: values['session-id'] as string,
    taskId: values['task-id'] as string,
    prompt: values.prompt as string,
    tool,
    permissionMode: (values['permission-mode'] as 'ask' | 'auto' | 'allow-all') || undefined,
    daemonUrl: resolvedDaemonUrl,
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
  console.error(`  --tool <name>            SDK tool (${ToolRegistry.getAll().join(', ')})`);
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
      'interactive-command': {
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
  if (values['interactive-command']) {
    await handleInteractiveCommandMode({ dryRun: values['dry-run'] || false });
  } else if (values.stdin) {
    await handleStdinMode({ dryRun: values['dry-run'] || false });
  } else if (values['session-token']) {
    // Legacy mode - use CLI arguments
    await handleLegacyMode(values);
  } else {
    // Usage lists the ordinary provider tools. Prompt execution itself performs
    // tool-specific lazy registration above.
    await initializeToolRegistry();
    printUsage();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[executor] Fatal error:', error);
  process.exit(1);
});
