/**
 * Execute Prompt Handler - Routes SDK execution to correct agent
 *
 * This handler receives execute_prompt requests from the daemon and:
 * 1. Requests API key from daemon via get_api_key
 * 2. Routes to appropriate SDK based on agentic_tool parameter
 * 3. Streams events back to daemon via report_message notifications
 */

import type { ExecutorIPCServer } from '../ipc-server.js';
import type { ExecutePromptParams, ExecutePromptResult } from '../types.js';
import { executeClaudeSDK } from './sdk/claude.js';
import { executeCodexSDK } from './sdk/codex.js';
import { executeGeminiSDK } from './sdk/gemini.js';
import { executeOpenCodeSDK } from './sdk/opencode.js';

/**
 * Main handler for execute_prompt requests
 */
export async function handleExecutePrompt(
  params: ExecutePromptParams,
  ipcServer: ExecutorIPCServer
): Promise<ExecutePromptResult> {
  const { session_token, agentic_tool } = params;

  console.log(`[executor] execute_prompt: tool=${agentic_tool}`);

  try {
    // Request API key from daemon just-in-time
    console.log(`[executor] Requesting API key for ${agentic_tool}...`);
    const apiKeyResponse = (await ipcServer.request('get_api_key', {
      session_token,
      credential_key: getCredentialKeyForTool(agentic_tool),
    })) as { api_key: string };

    console.log(`[executor] API key received, length: ${apiKeyResponse.api_key?.length || 0}`);
    const apiKey = apiKeyResponse.api_key || ''; // Allow empty API key - SDKs will handle auth

    // Route to appropriate SDK (pass API key even if empty - SDK will prompt for auth if needed)
    console.log(`[executor] Routing to SDK handler for: ${agentic_tool}`);
    let result: ExecutePromptResult;

    switch (agentic_tool) {
      case 'claude-code':
        result = await executeClaudeSDK(params, apiKey, ipcServer);
        break;

      case 'codex':
        result = await executeCodexSDK(params, apiKey, ipcServer);
        break;

      case 'gemini':
        result = await executeGeminiSDK(params, apiKey, ipcServer);
        break;

      case 'opencode':
        result = await executeOpenCodeSDK(params, apiKey, ipcServer);
        break;

      default:
        throw new Error(`Unknown agentic tool: ${agentic_tool}`);
    }

    console.log(
      `[executor] execute_prompt completed: status=${result.status}, messages=${result.message_count}`
    );

    return result;
  } catch (error) {
    const err = error as Error;
    console.error(`[executor] execute_prompt failed:`, err);

    return {
      status: 'failed',
      message_count: 0,
      error: {
        message: err.message,
        code: 'EXECUTOR_ERROR',
        stack: err.stack,
      },
    };
  }
}

/**
 * Map agentic tool to credential key
 */
function getCredentialKeyForTool(agenticTool: string): string {
  switch (agenticTool) {
    case 'claude-code':
      return 'ANTHROPIC_API_KEY';
    case 'codex':
      return 'OPENAI_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'opencode':
      // OpenCode doesn't need API key (uses local server)
      return 'NONE';
    default:
      throw new Error(`Unknown agentic tool: ${agenticTool}`);
  }
}
