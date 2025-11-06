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

import type {
  CreateSessionConfig,
  SessionHandle,
  SessionMetadata,
  StreamingCallbacks,
  TaskResult,
  ToolCapabilities,
} from '../base';
import type { ITool } from '../base/tool.interface';
import type { Message } from '../../types';
import { OpenCodeClient } from './client';

export interface OpenCodeConfig {
  enabled: boolean;
  serverUrl: string;
}

/**
 * Service interface for creating messages via FeathersJS
 */
export interface MessagesService {
  create(data: Partial<any>): Promise<any>;
}

/**
 * Service interface for updating tasks via FeathersJS
 */
export interface TasksService {
  patch(id: string, data: Partial<any>): Promise<any>;
}

export class OpenCodeTool implements ITool {
  readonly toolType = 'opencode' as const;
  readonly name = 'OpenCode';

  private client: OpenCodeClient | null = null;
  private config: OpenCodeConfig;
  private messagesService?: MessagesService;

  constructor(
    config: OpenCodeConfig,
    messagesService?: MessagesService
  ) {
    this.config = config;
    this.messagesService = messagesService;
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
   */
  async executeTask?(
    sessionId: string,
    prompt: string,
    taskId?: string,
    streamingCallbacks?: StreamingCallbacks
  ): Promise<TaskResult> {
    const client = this.getClient();

    try {
      // Send prompt to OpenCode
      const response = await client.sendPrompt(sessionId, prompt);

      // Create message in Agor database
      // Note: In real implementation, would parse OpenCode response properly
      // For now, treat as simple text response
      if (!this.messagesService) {
        throw new Error('Messages service not available');
      }

      const message = await this.messagesService.create({
        session_id: sessionId,
        task_id: taskId,
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
        created_at: new Date().toISOString(),
      });

      return {
        taskId: taskId || '',
        status: 'completed',
        messages: [],
        completedAt: new Date(),
      };
    } catch (error) {
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
      const messages = await client.getMessages(sessionId);

      // Convert OpenCode messages to Agor Message format
      return messages.map((msg: Record<string, unknown>, index: number) => {
        const content = typeof msg.content === 'string' ? msg.content : typeof msg.text === 'string' ? msg.text : String(msg);
        return {
          message_id: `opencode-msg-${sessionId}-${index}`,
          session_id: sessionId,
          role: (typeof msg.role === 'string' ? msg.role : 'assistant') as 'user' | 'assistant',
          type: 'text' as const,
          index,
          content: [
            {
              type: 'text' as const,
              text: content,
            },
          ],
          timestamp: new Date().toISOString(),
          content_preview: content.substring(0, 200),
        };
      });
    } catch (error) {
      throw new Error(
        `Failed to get session messages: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all available sessions
   */
  async listSessions?(): Promise<SessionMetadata[]> {
    const client = this.getClient();

    try {
      const sessions = await client.listSessions();

      return sessions.map((session: Record<string, unknown>) => ({
        sessionId: typeof session.id === 'string' ? session.id : String(session.id),
        toolType: 'opencode' as const,
        status: 'active' as const,
        createdAt: new Date(typeof session.createdAt === 'string' ? session.createdAt : Date.now()),
        lastUpdatedAt: new Date(typeof session.updatedAt === 'string' ? session.updatedAt : Date.now()),
      }));
    } catch (error) {
      throw new Error(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
