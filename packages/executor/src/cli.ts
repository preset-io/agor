/**
 * CLI entry point for executor
 *
 * New architecture: Executor is ephemeral and task-scoped.
 * Each executor subprocess executes exactly one task and then exits.
 * Communication with daemon is via Feathers/WebSocket (no IPC).
 */

import { parseArgs } from 'node:util';
import { AgorExecutor } from './index.js';

async function main() {
  // Parse command-line arguments
  const { values } = parseArgs({
    options: {
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

  // Validate required arguments
  if (
    !values['session-token'] ||
    !values['session-id'] ||
    !values['task-id'] ||
    !values.prompt ||
    !values.tool
  ) {
    console.error('Usage: agor-executor [OPTIONS]');
    console.error('');
    console.error('Required options:');
    console.error('  --session-token <jwt>    JWT for Feathers authentication');
    console.error('  --session-id <id>        Session ID to execute prompt for');
    console.error('  --task-id <id>           Task ID created by daemon');
    console.error('  --prompt <text>          User prompt to execute');
    console.error('  --tool <name>            SDK tool (claude-code, gemini, codex, opencode)');
    console.error('');
    console.error('Optional:');
    console.error('  --permission-mode <mode> Permission mode (ask, auto, allow-all)');
    console.error(
      '  --daemon-url <url>       Daemon WebSocket URL (default: http://localhost:3030)'
    );
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

main().catch((error) => {
  console.error('[executor] Fatal error:', error);
  process.exit(1);
});
