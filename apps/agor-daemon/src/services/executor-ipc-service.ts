/**
 * ExecutorIPCService - Handles incoming IPC requests from executors
 *
 * This service processes requests that executors make back to the daemon:
 * - get_api_key: Returns API keys just-in-time
 * - request_permission: Delegates to permission service for tool approval
 * - report_message: Creates message records and broadcasts via WebSocket
 */

import type { Database } from '@agor/core/db';
import { UsersRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { SessionTokenService } from './session-token-service';

export interface GetApiKeyParams {
  session_token: string;
  credential_key: string;
}

export interface GetApiKeyResult {
  api_key: string;
}

export interface RequestPermissionParams {
  session_token: string;
  task_id: string;
  tool_name: string;
  tool_params: unknown;
}

export interface RequestPermissionResult {
  approved: boolean;
  reason?: string;
}

export interface ReportMessageParams {
  session_token: string;
  task_id: string;
  sequence: number;
  timestamp: number;
  event_type: string;
  event_data: unknown;
}

export interface DaemonCommandParams {
  session_token: string;
  command: string;
  data: unknown;
}

export class ExecutorIPCService {
  private usersRepo: UsersRepository;

  constructor(
    private app: Application,
    db: Database,
    private sessionTokenService: SessionTokenService
  ) {
    this.usersRepo = new UsersRepository(db);
  }

  /**
   * Handle get_api_key request from executor
   * Returns API key for the requested credential
   */
  async handleGetApiKey(params: GetApiKeyParams): Promise<GetApiKeyResult> {
    const { session_token, credential_key } = params;

    console.log(`[ExecutorIPCService] get_api_key: credential=${credential_key}`);

    // Validate session token and get session info
    const sessionInfo = await this.sessionTokenService.validateToken(session_token);

    if (!sessionInfo) {
      throw new Error('Invalid or expired session token');
    }

    const { session_id, user_id } = sessionInfo;

    // Get API key from encrypted user credentials
    let apiKey: string | null = null;

    switch (credential_key) {
      case 'ANTHROPIC_API_KEY':
        apiKey = await this.usersRepo.getApiKey(user_id, 'anthropic');
        break;
      case 'OPENAI_API_KEY':
        apiKey = await this.usersRepo.getApiKey(user_id, 'openai');
        break;
      case 'GEMINI_API_KEY':
        apiKey = await this.usersRepo.getApiKey(user_id, 'gemini');
        break;
      case 'NONE':
        // OpenCode doesn't need API key
        apiKey = '';
        break;
      default:
        throw new Error(`Unknown credential key: ${credential_key}`);
    }

    // Fallback to environment variables if not in user credentials
    if (!apiKey && credential_key !== 'NONE') {
      console.log(
        `[ExecutorIPCService] API key not found in user credentials, falling back to environment variable`
      );

      switch (credential_key) {
        case 'ANTHROPIC_API_KEY':
          apiKey = process.env.ANTHROPIC_API_KEY || null;
          break;
        case 'OPENAI_API_KEY':
          apiKey = process.env.OPENAI_API_KEY || null;
          break;
        case 'GEMINI_API_KEY':
          apiKey = process.env.GEMINI_API_KEY || null;
          break;
      }
    }

    // Don't throw error if API key not found - let the SDK handle authentication
    // Claude Code and Gemini SDKs have their own authentication flows
    if (!apiKey && credential_key !== 'NONE') {
      console.log(
        `[ExecutorIPCService] API key not configured for ${credential_key}, returning empty - SDK will handle auth`
      );
      apiKey = ''; // Return empty string instead of throwing
    }

    console.log(
      `[ExecutorIPCService] get_api_key: success (session=${session_id}, user=${user_id})`
    );

    return {
      api_key: apiKey || '',
    };
  }

  /**
   * Handle request_permission request from executor
   * Delegates to permission service
   */
  async handleRequestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
    const { session_token, tool_name } = params;
    // task_id and tool_params will be used when permission service is integrated
    const _task_id = params.task_id;
    const _tool_params = params.tool_params;

    console.log(
      `[ExecutorIPCService] request_permission: tool=${tool_name}, task=${_task_id}, params=${JSON.stringify(_tool_params).slice(0, 100)}`
    );

    // Validate session token
    const sessionInfo = await this.sessionTokenService.validateToken(session_token);

    if (!sessionInfo) {
      throw new Error('Invalid or expired session token');
    }

    // TODO: Implement permission service integration
    // For now, auto-approve all tools
    console.log(`[ExecutorIPCService] request_permission: auto-approved (tool=${tool_name})`);

    return {
      approved: true,
    };
  }

  /**
   * Handle report_message notification from executor
   * Broadcasts streaming events via WebSocket without creating database records
   *
   * Note: Streaming events (partial, tool_start, etc.) are ephemeral and only
   * need to be broadcast for real-time UI updates. The final messages will be
   * created when execution completes.
   */
  async handleReportMessage(params: ReportMessageParams): Promise<void> {
    const { session_token, task_id, sequence, timestamp, event_type, event_data } = params;

    console.log(`[ExecutorIPCService] report_message: seq=${sequence}, type=${event_type}`);

    // Validate session token
    const sessionInfo = await this.sessionTokenService.validateToken(session_token);

    if (!sessionInfo) {
      throw new Error('Invalid or expired session token');
    }

    const { session_id } = sessionInfo;

    try {
      // Broadcast streaming event to WebSocket clients
      // Format: { session_id, task_id, sequence, timestamp, event_type, event_data }
      this.app.service('sessions').emit('streaming_event', {
        session_id,
        task_id,
        sequence,
        timestamp,
        event_type,
        event_data,
      });

      console.log(
        `[ExecutorIPCService] report_message: broadcasted (session=${session_id}, type=${event_type}, seq=${sequence})`
      );
    } catch (error) {
      const err = error as Error;
      console.error(`[ExecutorIPCService] report_message failed:`, err.message);
      // Don't throw - this is a notification, not a request
      // Executor doesn't need a response, so just log and continue
    }
  }

  /**
   * Handle daemon_command notification from executor
   * Routes to specific command handlers (emit_permission_event, stream events, etc.)
   */
  async handleDaemonCommand(params: DaemonCommandParams): Promise<void> {
    const { session_token, command, data } = params;

    console.log(`[ExecutorIPCService] daemon_command: command=${command}`);

    // Validate session token
    const sessionInfo = await this.sessionTokenService.validateToken(session_token);
    if (!sessionInfo) {
      throw new Error('Invalid or expired session token');
    }

    const { session_id } = sessionInfo;

    try {
      switch (command) {
        case 'emit_permission_event': {
          // Executor wants to emit a permission event to UI via WebSocket
          const { event, data: eventData } = data as { event: string; data: unknown };
          console.log(`[ExecutorIPCService] Emitting permission event: ${event}`);

          // Broadcast via WebSocket (sessions service handles this)
          this.app.service('sessions').emit(event, eventData);
          break;
        }

        case 'stream_chunk':
        case 'stream_start':
        case 'thinking_start':
        case 'thinking_chunk':
        case 'thinking_end': {
          // Broadcast streaming events to WebSocket clients
          this.app.service('sessions').emit(command, {
            session_id,
            ...(data as Record<string, unknown>),
          });
          break;
        }

        default:
          console.warn(`[ExecutorIPCService] Unknown daemon_command: ${command}`);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`[ExecutorIPCService] daemon_command failed:`, err.message);
      // Don't throw - this is a notification, executor doesn't expect response
    }
  }
}
