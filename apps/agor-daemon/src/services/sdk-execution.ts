/**
 * SDK Execution Router
 *
 * Routes SDK execution based on execution.use_executor config flag:
 * - When enabled: Execute via isolated executor process with session tokens
 * - When disabled: Execute directly in daemon process (legacy behavior)
 *
 * This provides a transparent wrapper that maintains backward compatibility
 * while enabling executor-based execution for security and isolation.
 */

import type { Application } from '@agor/core/feathers';
import type { ExecutorPool } from './executor-pool';
import type { SessionTokenService } from './session-token-service';

// Extended Application type with executor services attached
interface ApplicationWithExecutor extends Application {
  executorPool?: ExecutorPool;
  sessionTokenService?: SessionTokenService;
  sessionExecutors?: Map<string, string>; // sessionId -> executorId mapping
}

export interface ExecuteSDKOptions {
  sessionId: string;
  taskId: string;
  userId: string;
  agenticTool: 'claude-code' | 'codex' | 'gemini' | 'opencode';
  prompt: string;
  cwd: string;
  tools?: string[];
  permissionMode?: string;
  timeoutMs?: number;
}

export interface ExecuteSDKResult {
  status: 'completed' | 'failed' | 'cancelled';
  messageCount: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  error?: {
    message: string;
    code: string;
    stack?: string;
  };
}

// Result type from executor IPC response
interface ExecutorResult {
  status: 'completed' | 'failed' | 'cancelled';
  message_count: number;
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  error?: {
    message: string;
    code: string;
    stack?: string;
  };
}

/**
 * Execute SDK via executor or directly based on config
 */
export async function executeSDK(
  app: Application,
  options: ExecuteSDKOptions
): Promise<ExecuteSDKResult> {
  const appWithExecutor = app as ApplicationWithExecutor;
  const executorPool = appWithExecutor.executorPool;
  const sessionTokenService = appWithExecutor.sessionTokenService;

  // If executor services not initialized, throw error
  if (!executorPool || !sessionTokenService) {
    throw new Error(
      'Executor services not initialized. Set execution.use_executor=true in config to enable executor-based execution.'
    );
  }

  console.log(
    `[SDK Execution] Routing to executor: session=${options.sessionId}, tool=${options.agenticTool}`
  );

  // Generate session token (JWT) for this execution
  const sessionToken = await sessionTokenService.generateToken(options.sessionId, options.userId);

  try {
    // Spawn executor for this session
    const executor = await executorPool.spawn({
      userId: options.userId,
    });

    console.log(`[SDK Execution] Executor spawned: ${executor.id.slice(0, 8)}`);

    // Store session -> executor mapping in app context
    // This allows permission hooks to find the executor for a given session
    if (!appWithExecutor.sessionExecutors) {
      appWithExecutor.sessionExecutors = new Map();
    }
    appWithExecutor.sessionExecutors.set(options.sessionId, executor.id);
    console.log(
      `[SDK Execution] Session ${options.sessionId.slice(0, 8)} linked to executor ${executor.id.slice(0, 8)}`
    );

    // Execute via executor
    const result = await executor.client.request(
      'execute_prompt',
      {
        session_token: sessionToken,
        session_id: options.sessionId,
        task_id: options.taskId,
        agentic_tool: options.agenticTool,
        prompt: options.prompt,
        cwd: options.cwd,
        tools: options.tools || [],
        permission_mode: options.permissionMode || 'default',
        timeout_ms: options.timeoutMs || 0,
        stream: true,
      },
      (options.timeoutMs || 120000) + 5000 // Add 5s buffer to IPC timeout
    );

    const executorResult = result as ExecutorResult;
    console.log(`[SDK Execution] Completed: status=${executorResult.status}`);

    // Clear session -> executor mapping
    appWithExecutor.sessionExecutors?.delete(options.sessionId);

    // Terminate executor after execution
    await executorPool.terminate(executor.id);

    return {
      status: executorResult.status,
      messageCount: executorResult.message_count,
      tokenUsage: executorResult.token_usage
        ? {
            inputTokens: executorResult.token_usage.input_tokens,
            outputTokens: executorResult.token_usage.output_tokens,
            cacheReadTokens: executorResult.token_usage.cache_read_tokens,
            cacheWriteTokens: executorResult.token_usage.cache_write_tokens,
          }
        : undefined,
      error: executorResult.error,
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[SDK Execution] Failed:`, err);

    // Revoke token on error
    sessionTokenService.revokeToken(sessionToken);

    return {
      status: 'failed',
      messageCount: 0,
      error: {
        message: err.message,
        code: 'SDK_EXECUTION_ERROR',
        stack: err.stack,
      },
    };
  }
}
