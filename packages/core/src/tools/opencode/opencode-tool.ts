/**
 * OpenCode Tool Implementation
 *
 * Implements the ITool interface for OpenCode.ai integration.
 * OpenCode is an open-source terminal-based AI coding assistant supporting 75+ LLM providers.
 *
 * Current capabilities:
 * - ✅ Create new sessions
 * - ✅ Send prompts and receive responses
 * - ✅ Get session metadata and messages
 * - ✅ Real-time streaming support via SSE
 * - ⏳ Session import (future: when OpenCode provides export API)
 */

import { generateId } from '../../lib/ids';
import type { Message, SessionID, TaskID } from '../../types';
import { MessageRole } from '../../types';
import type {
  CreateSessionConfig,
  SessionHandle,
  SessionMetadata,
  StreamingCallbacks,
  TaskResult,
  ToolCapabilities,
} from '../base';
import type { ITool } from '../base/tool.interface';
import { OpenCodeClient } from './client';

export interface OpenCodeConfig {
  enabled: boolean;
  serverUrl: string;
}

/**
 * Service interface for creating messages via FeathersJS
 */
export interface MessagesService {
  create(data: Partial<Message>): Promise<Message>;
}

/**
 * Service interface for updating tasks via FeathersJS
 */
export interface TasksService {
  patch(id: string, data: Partial<{ status: string }>): Promise<unknown>;
}

export class OpenCodeTool implements ITool {
  readonly toolType = 'opencode' as const;
  readonly name = 'OpenCode';

  private client: OpenCodeClient | null = null;
  private config: OpenCodeConfig;
  private messagesService?: MessagesService;
  private sessionMap: Map<string, string> = new Map(); // Agor session ID → OpenCode session ID
  private sessionModels: Map<string, string | undefined> = new Map(); // Agor session ID → model

  constructor(config: OpenCodeConfig, messagesService?: MessagesService) {
    this.config = config;
    this.messagesService = messagesService;
  }

  /**
   * Map an Agor session ID to an OpenCode session ID
   */
  mapSession(agorSessionId: string, opencodeSessionId: string): void {
    this.sessionMap.set(agorSessionId, opencodeSessionId);
  }

  /**
   * Set session context (OpenCode session ID and model) for an Agor session
   * Must be called before executeTask
   */
  setSessionContext(agorSessionId: string, opencodeSessionId: string, model?: string): void {
    this.sessionMap.set(agorSessionId, opencodeSessionId);
    this.sessionModels.set(agorSessionId, model);
  }

  /**
   * Initialize the client if not already initialized
   */
  private getClient(): OpenCodeClient {
    if (!this.client) {
      this.client = new OpenCodeClient({
        serverUrl: this.config.serverUrl,
      });
    }
    return this.client;
  }

  /**
   * Get tool capabilities
   */
  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: false, // Future: add when OpenCode provides export API
      supportsSessionCreate: true,
      supportsLiveExecution: true,
      supportsSessionFork: false, // Not currently supported
      supportsChildSpawn: false, // Not currently supported
      supportsGitState: false, // OpenCode doesn't track git state
      supportsStreaming: true, // Supports SSE streaming
    };
  }

  /**
   * Check if OpenCode server is installed and accessible
   */
  async checkInstalled(): Promise<boolean> {
    try {
      const client = this.getClient();
      return await client.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Create a new OpenCode session
   */
  async createSession?(config: CreateSessionConfig): Promise<SessionHandle> {
    const client = this.getClient();

    try {
      const session = await client.createSession({
        title: String(config.title || 'Agor Session'),
        project: String(config.projectName || 'default'),
      });

      return {
        sessionId: session.id,
        toolType: 'opencode',
      };
    } catch (error) {
      throw new Error(
        `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Execute task (send prompt) in OpenCode session
   *
   * Sends prompt to OpenCode and streams response if callbacks provided.
   * CONTRACT: Must call messagesService.create() with complete message
   *
   * NOTE: Must call setSessionContext() before this method to set OpenCode session ID and model
   *
   * @param sessionId - Agor session ID (for message creation)
   * @param prompt - User prompt
   * @param taskId - Task ID
   * @param streamingCallbacks - Optional streaming callbacks
   */
  async executeTask?(
    sessionId: string,
    prompt: string,
    taskId?: string,
    streamingCallbacks?: StreamingCallbacks
  ): Promise<TaskResult> {
    const client = this.getClient();

    try {
      // Get OpenCode session ID and model from stored context
      const opencodeSessionId = this.sessionMap.get(sessionId);
      const model = this.sessionModels.get(sessionId);

      console.log('[OpenCodeTool] executeTask called:', {
        sessionId,
        opencodeSessionId,
        taskId,
        promptLength: prompt.length,
        model,
      });

      if (!opencodeSessionId) {
        throw new Error(
          `OpenCode session ID not found for Agor session ${sessionId}. Call setSessionContext() first.`
        );
      }
      console.log('[OpenCodeTool] Using OpenCode session:', opencodeSessionId);

      if (model) {
        console.log('[OpenCodeTool] Using model:', model);
      }

      // Send prompt to OpenCode with optional model
      const response = await client.sendPrompt(opencodeSessionId, prompt, model);
      console.log('[OpenCodeTool] sendPrompt response received:', response.substring(0, 100));

      // Create message in Agor database
      // Note: In real implementation, would parse OpenCode response properly
      // For now, treat as simple text response
      if (!this.messagesService) {
        throw new Error('Messages service not available');
      }

      const message = await this.messagesService.create({
        message_id: generateId(),
        session_id: sessionId as SessionID,
        task_id: taskId as TaskID | undefined,
        type: 'assistant' as const,
        role: MessageRole.ASSISTANT,
        index: 0, // Assistant's first response in this task
        timestamp: new Date().toISOString(),
        content_preview: response.substring(0, 200),
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
      });

      console.log('[OpenCodeTool] Message created:', message);

      return {
        taskId: taskId || '',
        status: 'completed',
        messages: [],
        completedAt: new Date(),
      };
    } catch (error) {
      console.error('[OpenCodeTool] executeTask failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      return {
        taskId: taskId || '',
        status: 'failed',
        messages: [],
        error: errorObj,
        completedAt: new Date(),
      };
    }
  }

  /**
   * Get session metadata
   */
  async getSessionMetadata?(sessionId: string): Promise<SessionMetadata> {
    const client = this.getClient();

    try {
      const metadata = (await client.getSessionMetadata(sessionId)) as Record<string, unknown>;
      return {
        sessionId,
        toolType: 'opencode' as const,
        status: 'active',
        createdAt: new Date((metadata.createdAt as string | number) || Date.now()),
        lastUpdatedAt: new Date(),
      };
    } catch (error) {
      throw new Error(
        `Failed to get session metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get session messages
   */
  async getSessionMessages?(sessionId: string): Promise<Message[]> {
    const client = this.getClient();

    try {
      // TODO: Implement proper message fetching from OpenCode
      // For now, return empty array since OpenCode messages are streamed directly
      await client.getMessages(sessionId);
      return [];
    } catch (error) {
      console.error('Failed to get session messages:', error);
      // Don't throw - return empty array as fallback
      return [];
    }
  }

  /**
   * List all available sessions
   */
  async listSessions?(): Promise<SessionMetadata[]> {
    const client = this.getClient();

    try {
      const sessions = await client.listSessions();

      return sessions.map(session => ({
        sessionId: session.id,
        toolType: 'opencode' as const,
        status: 'active' as const,
        createdAt: new Date(session.createdAt),
        lastUpdatedAt: new Date(),
      }));
    } catch (error) {
      throw new Error(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
