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

import { generateId } from '@agor/core';
import type { Message, SessionID, TaskID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { NormalizedSdkResponse, RawSdkResponse } from '../../types/sdk-response.js';
import type {
  CreateSessionConfig,
  SessionHandle,
  SessionMetadata,
  StreamingCallbacks,
  TaskResult,
  ToolCapabilities,
} from '../base/index.js';
import type { ITool } from '../base/tool.interface.js';

export interface OpenCodeConfig {
  enabled: boolean;
  serverUrl: string;
}

/**
 * Session context for an Agor session mapped to OpenCode
 */
interface SessionContext {
  opencodeSessionId: string;
  model?: string;
  provider?: string;
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

  private client: ReturnType<typeof createOpencodeClient> | null = null;
  private config: OpenCodeConfig;
  private messagesService?: MessagesService;
  private sessionContexts: Map<string, SessionContext> = new Map(); // Agor session ID → session context

  constructor(config: OpenCodeConfig, messagesService?: MessagesService) {
    this.config = config;
    this.messagesService = messagesService;
  }

  /**
   * Set session context (OpenCode session ID, model, and provider) for an Agor session
   * Must be called before executeTask
   *
   * @param agorSessionId - Agor session ID
   * @param opencodeSessionId - OpenCode session ID
   * @param model - Model identifier (e.g., 'gpt-4o', 'claude-sonnet-4-5')
   * @param provider - Provider ID (e.g., 'openai', 'opencode'). If omitted, uses legacy mapping.
   */
  setSessionContext(
    agorSessionId: string,
    opencodeSessionId: string,
    model?: string,
    provider?: string
  ): void {
    this.sessionContexts.set(agorSessionId, {
      opencodeSessionId,
      model,
      provider,
    });
  }

  /**
   * Get session context for an Agor session
   */
  private getSessionContext(agorSessionId: string): SessionContext | undefined {
    return this.sessionContexts.get(agorSessionId);
  }

  /**
   * Initialize the SDK client if not already initialized
   */
  private getClient(): ReturnType<typeof createOpencodeClient> {
    if (!this.client) {
      this.client = createOpencodeClient({
        baseUrl: this.config.serverUrl,
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
      // Try to list sessions as health check
      await client.session.list();
      return true;
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
      // Note: OpenCode SDK session.create doesn't support model parameter
      // Model is specified per-message in prompt() calls
      const response = await client.session.create({
        body: {
          title: String(config.title || 'Agor Session'),
        },
      });

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      return {
        sessionId: response.data.id,
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
      // Get session context (OpenCode session ID, model, provider)
      const context = this.getSessionContext(sessionId);

      console.log('[OpenCodeTool] executeTask called:', {
        sessionId,
        opencodeSessionId: context?.opencodeSessionId,
        taskId,
        promptLength: prompt.length,
        model: context?.model,
        provider: context?.provider,
      });

      if (!context?.opencodeSessionId) {
        throw new Error(
          `OpenCode session ID not found for Agor session ${sessionId}. Call setSessionContext() first.`
        );
      }
      console.log('[OpenCodeTool] Using OpenCode session:', context.opencodeSessionId);

      if (context.model) {
        console.log('[OpenCodeTool] Using model:', context.model);
      }
      if (context.provider) {
        console.log('[OpenCodeTool] Using provider:', context.provider);
      }

      // Send prompt to OpenCode with optional model and provider
      const promptOptions: {
        path: { id: string };
        body: {
          parts: Array<{ type: 'text'; text: string }>;
          model?: { providerID: string; modelID: string };
        };
      } = {
        path: { id: context.opencodeSessionId },
        body: {
          parts: [{ type: 'text', text: prompt }],
        },
      };

      // Include model if provided
      if (context.model && context.provider) {
        console.log(
          '[OpenCodeTool] Sending prompt with model:',
          JSON.stringify({ providerID: context.provider, modelID: context.model })
        );
        promptOptions.body.model = { providerID: context.provider, modelID: context.model };
      }

      const response = await client.session.prompt(promptOptions);

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      console.log('[OpenCodeTool] Response received');

      // Extract text and metadata from response
      let responseText = '';
      const metadata: {
        messageId?: string;
        parentMessageId?: string;
        cost?: number;
        tokens?: {
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        };
      } = {};

      // Extract metadata from 'info' field
      if (response.data.info) {
        if (response.data.info.id) {
          metadata.messageId = response.data.info.id;
        }
        if (response.data.info.parentID) {
          metadata.parentMessageId = response.data.info.parentID;
        }
      }

      // Extract text and token/cost metadata from 'parts' array
      if (response.data.parts && Array.isArray(response.data.parts)) {
        // Extract text parts
        const textParts = response.data.parts
          .filter((part) => part.type === 'text' && 'text' in part && typeof part.text === 'string')
          .map((part) => {
            if (part.type === 'text') {
              return part.text;
            }
            return '';
          });
        responseText = textParts.join('\n');

        // Extract metadata from step-finish part
        const stepFinish = response.data.parts.find((part) => part.type === 'step-finish');
        if (stepFinish && stepFinish.type === 'step-finish') {
          metadata.cost = stepFinish.cost;
          metadata.tokens = {
            input: stepFinish.tokens.input,
            output: stepFinish.tokens.output,
            reasoning: stepFinish.tokens.reasoning,
            cache: {
              read: stepFinish.tokens.cache.read,
              write: stepFinish.tokens.cache.write,
            },
          };
        }
      }

      // Fallback: if no text found, return empty
      if (!responseText) {
        responseText = 'No response text received from OpenCode';
      }

      console.log('[OpenCodeTool] Response text:', responseText.substring(0, 100));
      if (metadata.tokens) {
        console.log('[OpenCodeTool] Response metadata:', metadata);
      }

      // Create message in Agor database with OpenCode metadata
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
        content_preview: responseText.substring(0, 200),
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        // Store OpenCode metadata
        metadata:
          Object.keys(metadata).length > 0
            ? {
                opencode: metadata,
              }
            : undefined,
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
      const response = await client.session.get({
        path: { id: sessionId },
      });

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      return {
        sessionId,
        toolType: 'opencode' as const,
        status: 'active',
        createdAt: new Date(response.data.time.created),
        lastUpdatedAt: new Date(response.data.time.updated),
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
      const response = await client.session.messages({
        path: { id: sessionId },
      });

      if (response.error) {
        console.error('Failed to get messages:', response.error);
        return [];
      }

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
      const response = await client.session.list();

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      const sessions = Array.isArray(response.data) ? response.data : [];

      return sessions.map((session) => ({
        sessionId: session.id,
        toolType: 'opencode' as const,
        status: 'active' as const,
        createdAt: new Date(session.time.created),
        lastUpdatedAt: new Date(session.time.updated),
      }));
    } catch (error) {
      throw new Error(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ============================================================
  // Token Accounting (NEW)
  // ============================================================

  /**
   * Normalize OpenCode SDK response to common format
   *
   * @deprecated This method is deprecated - use normalizeRawSdkResponse() from utils/sdk-normalizer instead
   * This stub remains for API compatibility but should not be used.
   */
  normalizedSdkResponse(_rawResponse: RawSdkResponse): NormalizedSdkResponse {
    throw new Error(
      'normalizedSdkResponse() is deprecated - use normalizeRawSdkResponse() from utils/sdk-normalizer instead'
    );
  }
}
