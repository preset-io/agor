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
import type { Message, MessageID, SessionID, TaskID } from '@agor/core/types';
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
   * Execute task (send prompt) in OpenCode session WITH STREAMING
   *
   * Subscribes to OpenCode event stream, sends prompt, and streams response parts in real-time.
   * Handles reasoning, text, tool execution, and file edits as they arrive.
   * CONTRACT: Must call messagesService.create() with complete message
   *
   * NOTE: Must call setSessionContext() before this method to set OpenCode session ID and model
   *
   * @param sessionId - Agor session ID (for message creation)
   * @param prompt - User prompt
   * @param taskId - Task ID
   * @param streamingCallbacks - Optional streaming callbacks for real-time UI updates
   * @param messageIndex - Index for the assistant message (handler creates user message first)
   */
  async executeTask?(
    sessionId: string,
    prompt: string,
    taskId?: string,
    streamingCallbacks?: StreamingCallbacks,
    messageIndex?: number
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
        streaming: !!streamingCallbacks,
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

      // Prepare prompt options
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

      // If no streaming callbacks, use non-streaming path
      if (!streamingCallbacks) {
        console.log('[OpenCodeTool] No streaming callbacks, using non-streaming execution');
        return await this.executeTaskNonStreaming(
          client,
          sessionId,
          taskId,
          promptOptions,
          context.opencodeSessionId,
          messageIndex
        );
      }

      // STREAMING PATH: Subscribe to events and stream response parts
      console.log('[OpenCodeTool] Starting streaming execution...');

      // Track accumulated parts by part ID
      const partContents = new Map<string, string>();
      const partTypes = new Map<string, string>();
      const allParts: Array<{ id: string; type: string; data: unknown }> = []; // Store all parts for later processing
      let currentTextMessageId: string | null = null;
      let currentReasoningMessageId: string | null = null;

      // IMPORTANT: Subscribe to event stream BEFORE sending prompt
      // Events are emitted in real-time as prompt executes
      console.log('[OpenCodeTool] Subscribing to event stream...');
      const eventStream = await client.event.subscribe();
      console.log('[OpenCodeTool] Event stream ready, sending prompt...');

      // Start prompt in background (don't await yet)
      const promptPromise = client.session.prompt(promptOptions);
      console.log('[OpenCodeTool] Prompt sent, waiting for events...');

      // Process events as they arrive
      let _responseCompleted = false;
      let assistantMessageId: string | undefined;
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

      try {
        console.log('[OpenCodeTool] Listening for events...');

        for await (const event of eventStream.stream) {
          // Log EVERY event for debugging
          console.log('[OpenCodeTool] ========== RAW EVENT ==========');
          console.log('[OpenCodeTool] Event type:', event.type);
          console.log('[OpenCodeTool] Event data:', JSON.stringify(event, null, 2));
          console.log('[OpenCodeTool] ================================');

          // Check if this event is for our session
          if ('properties' in event) {
            // First, identify the assistant message when it's created
            if (
              event.type === 'message.updated' &&
              'info' in event.properties &&
              event.properties.info.sessionID === context.opencodeSessionId &&
              event.properties.info.role === 'assistant'
            ) {
              if (!assistantMessageId) {
                assistantMessageId = event.properties.info.id;
                console.log('[OpenCodeTool] Assistant message identified:', assistantMessageId);

                // Capture metadata
                metadata.messageId = event.properties.info.id;
                if (event.properties.info.parentID) {
                  metadata.parentMessageId = event.properties.info.parentID;
                }
              }
            }

            // Handle message.part.updated events - these contain the streaming updates
            // ONLY process parts from the assistant message, not the user message!
            if (event.type === 'message.part.updated' && 'part' in event.properties) {
              const part = event.properties.part;

              // Skip if this part is not from the assistant message
              if (!assistantMessageId || part.messageID !== assistantMessageId) {
                console.log(
                  '[OpenCodeTool] Skipping part from non-assistant message:',
                  part.messageID
                );
                continue;
              }

              // Store this part for later processing (building final message)
              const existingPartIndex = allParts.findIndex((p) => p.id === part.id);
              if (existingPartIndex >= 0) {
                allParts[existingPartIndex] = { id: part.id, type: part.type, data: part };
              } else {
                allParts.push({ id: part.id, type: part.type, data: part });
              }

              // OpenCode sends full text each time, not deltas
              // We need to calculate the delta ourselves
              // biome-ignore lint/suspicious/noExplicitAny: Part types vary, text field is runtime checked
              const newText =
                // biome-ignore lint/suspicious/noExplicitAny: Part types vary, text field is runtime checked
                'text' in part && typeof (part as any).text === 'string'
                  ? // biome-ignore lint/suspicious/noExplicitAny: Part types vary, text field is runtime checked
                    (part as any).text
                  : undefined;

              if (newText) {
                // Get previous text for this part
                const previousText = partContents.get(part.id) || '';

                // Calculate delta (new characters added)
                const delta = newText.substring(previousText.length);

                // Update stored content
                partContents.set(part.id, newText);
                partTypes.set(part.id, part.type);

                console.log(
                  '[OpenCodeTool] Part update:',
                  part.type,
                  'delta length:',
                  delta.length,
                  'total length:',
                  newText.length
                );

                // Stream delta to UI based on part type
                if (delta.length > 0) {
                  if (part.type === 'reasoning') {
                    // Stream reasoning chunks
                    if (!currentReasoningMessageId) {
                      currentReasoningMessageId = generateId();
                      streamingCallbacks.onThinkingStart?.(
                        currentReasoningMessageId as MessageID,
                        {}
                      );
                    }
                    streamingCallbacks.onThinkingChunk?.(
                      currentReasoningMessageId as MessageID,
                      delta
                    );
                  } else if (part.type === 'text') {
                    // Stream text chunks
                    if (!currentTextMessageId) {
                      currentTextMessageId = generateId();
                      streamingCallbacks.onStreamStart(currentTextMessageId as MessageID, {
                        session_id: sessionId as SessionID,
                        task_id: taskId as TaskID | undefined,
                        role: 'assistant',
                        timestamp: new Date().toISOString(),
                      });
                    }
                    streamingCallbacks.onStreamChunk(currentTextMessageId as MessageID, delta);
                  } else if (part.type === 'tool') {
                    // Tool execution - log full details
                    console.log('[OpenCodeTool] ========== TOOL PART ==========');
                    console.log('[OpenCodeTool] Tool part ID:', part.id);
                    console.log('[OpenCodeTool] Tool part data:', JSON.stringify(part, null, 2));
                    console.log('[OpenCodeTool] ================================');
                  }
                }
              } else if (part.type === 'tool') {
                // Tool parts without text field - log full structure
                console.log('[OpenCodeTool] ========== TOOL PART (no text) ==========');
                console.log('[OpenCodeTool] Tool part ID:', part.id);
                console.log('[OpenCodeTool] Tool part data:', JSON.stringify(part, null, 2));
                console.log('[OpenCodeTool] ===================================');
              }
            }

            // Check for session idle status - indicates response is complete
            // biome-ignore lint/suspicious/noExplicitAny: Event types incomplete, runtime check needed
            if (
              // biome-ignore lint/suspicious/noExplicitAny: Event types incomplete, runtime check needed
              (event as any).type === 'session.status' &&
              // biome-ignore lint/suspicious/noExplicitAny: Event types incomplete, runtime check needed
              (event as any).properties?.status?.type === 'idle'
            ) {
              console.log('[OpenCodeTool] Session became idle, response complete');
              _responseCompleted = true;
              break; // Exit event loop
            }
          }
        }
      } finally {
        // Clean up event stream
        console.log('[OpenCodeTool] Closing event stream...');
        // Note: The SDK's async generator should clean up automatically when we break/return
      }

      // Wait for prompt to complete
      console.log('[OpenCodeTool] Waiting for prompt response...');
      const response = await promptPromise;

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      console.log('[OpenCodeTool] ========== FINAL RESPONSE ==========');
      console.log('[OpenCodeTool] Response data:', JSON.stringify(response.data, null, 2));
      console.log('[OpenCodeTool] ===================================');

      // Check for error in response
      // biome-ignore lint/suspicious/noExplicitAny: Response structure varies, runtime check needed
      let hasError = false;
      let errorMessage = '';
      // biome-ignore lint/suspicious/noExplicitAny: Response structure varies, runtime check needed
      if (response.data.info && (response.data.info as any).error) {
        // biome-ignore lint/suspicious/noExplicitAny: Error structure varies
        const errorInfo = (response.data.info as any).error;
        errorMessage =
          errorInfo.data?.message || errorInfo.message || 'Unknown error from OpenCode';
        console.error('[OpenCodeTool] OpenCode returned error:', errorMessage);
        hasError = true;

        // Stream the error message to the user as assistant response
        if (!currentTextMessageId) {
          currentTextMessageId = generateId();
          streamingCallbacks.onStreamStart(currentTextMessageId as MessageID, {
            session_id: sessionId as SessionID,
            task_id: taskId as TaskID | undefined,
            role: 'assistant',
            timestamp: new Date().toISOString(),
          });
        }

        // Format error message for display
        const formattedError = `❌ **OpenCode Error**\n\n${errorMessage}`;
        streamingCallbacks.onStreamChunk(currentTextMessageId as MessageID, formattedError);
      }

      // End streaming notifications
      if (currentReasoningMessageId) {
        streamingCallbacks.onThinkingEnd?.(currentReasoningMessageId as MessageID);
      }
      if (currentTextMessageId) {
        streamingCallbacks.onStreamEnd(currentTextMessageId as MessageID);
      }

      // Extract final text from parts (or use error message if error occurred)
      let responseText = '';
      const textParts: string[] = [];

      if (hasError) {
        // Use the error message as the response text
        responseText = `❌ **OpenCode Error**\n\n${errorMessage}`;
      } else {
        // Only extract text from parts if no error occurred
        for (const part of response.data.parts || []) {
          // Collect text from reasoning and text parts
          if (part.type === 'reasoning' || part.type === 'text') {
            // biome-ignore lint/suspicious/noExplicitAny: Part types vary, check for text field at runtime
            if ('text' in part && typeof (part as any).text === 'string') {
              // biome-ignore lint/suspicious/noExplicitAny: Checked above
              textParts.push((part as any).text);
            }
          }

          // Extract metadata from step-finish part
          if (part.type === 'step-finish') {
            metadata.cost = part.cost;
            metadata.tokens = {
              input: part.tokens.input,
              output: part.tokens.output,
              reasoning: part.tokens.reasoning,
              cache: {
                read: part.tokens.cache.read,
                write: part.tokens.cache.write,
              },
            };
          }
        }

        responseText = textParts.join('\n');
        console.log('[OpenCodeTool] Final text length:', responseText.length);

        // Fallback: if no text found, return message
        if (!responseText) {
          responseText = 'No response text received from OpenCode';
        }
      }

      // Create assistant message in Agor database with OpenCode metadata
      if (!this.messagesService) {
        throw new Error('Messages service not available');
      }

      // Use provided index or default to 0
      // Handler should create user message first with index N, then pass N+1 here
      const assistantIndex = messageIndex ?? 0;

      // Build content blocks from all parts
      const contentBlocks: Array<{
        type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
        [key: string]: unknown;
      }> = [];
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      // Process parts from final response (not from streaming cache)
      // The final response contains ALL parts, including ones that weren't streamed
      const finalParts = response.data.parts || [];
      console.log(
        '[OpenCodeTool] Building message content from',
        finalParts.length,
        'parts in final response'
      );
      // biome-ignore lint/suspicious/noExplicitAny: Part types vary at runtime
      console.log('[OpenCodeTool] Part types:', finalParts.map((p: any) => p.type).join(', '));
      for (const part of finalParts) {
        // biome-ignore lint/suspicious/noExplicitAny: Part types vary, runtime check needed
        const partData = part as any;
        console.log('[OpenCodeTool] Processing part type:', partData.type);

        if (partData.type === 'reasoning' && partData.text) {
          console.log('[OpenCodeTool] Adding reasoning block, text length:', partData.text.length);
          contentBlocks.push({
            type: 'thinking',
            text: partData.text,
          });
        } else if (partData.type === 'reasoning') {
          console.log('[OpenCodeTool] Skipping reasoning part - no text field or empty text');
        }

        if (partData.type === 'text' && partData.text) {
          contentBlocks.push({
            type: 'text',
            text: partData.text,
          });
        } else if (partData.type === 'tool') {
          // Tool use block - extract tool info
          // OpenCode structure: { tool: string, callID: string, state: { input: {...}, output: "..." } }
          console.log('[OpenCodeTool] Processing tool part:', JSON.stringify(partData, null, 2));

          const toolName = partData.tool || 'unknown';
          const toolInput = partData.state?.input || {};
          const toolCallId = partData.callID || partData.id;

          // Add tool_use block
          contentBlocks.push({
            type: 'tool_use',
            id: toolCallId,
            name: toolName,
            input: toolInput,
          });

          // Add to tool_uses array
          toolUses.push({
            id: toolCallId,
            name: toolName,
            input: toolInput,
          });

          // If tool has completed with output, add tool_result block
          if (partData.state?.status === 'completed' && partData.state?.output) {
            contentBlocks.push({
              type: 'tool_result',
              tool_use_id: toolCallId,
              content: partData.state.output,
            });
          }
        }
      }

      // If no content blocks were created (error case), add the error text
      if (contentBlocks.length === 0 && responseText) {
        contentBlocks.push({
          type: 'text',
          text: responseText,
        });
      }

      console.log(
        '[OpenCodeTool] Created',
        contentBlocks.length,
        'content blocks,',
        toolUses.length,
        'tool uses'
      );

      const message = await this.messagesService.create({
        message_id: (currentTextMessageId || generateId()) as MessageID,
        session_id: sessionId as SessionID,
        task_id: taskId as TaskID | undefined,
        type: 'assistant' as const,
        role: MessageRole.ASSISTANT,
        index: assistantIndex,
        timestamp: new Date().toISOString(),
        content_preview: responseText.substring(0, 200),
        content: contentBlocks,
        tool_uses: toolUses.length > 0 ? toolUses : undefined,
        // Store OpenCode metadata
        metadata:
          Object.keys(metadata).length > 0
            ? {
                opencode: metadata,
              }
            : undefined,
      });

      console.log('[OpenCodeTool] Message created:', message.message_id);

      return {
        taskId: taskId || '',
        status: hasError ? 'failed' : 'completed',
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
   * Non-streaming execution path (fallback when no callbacks provided)
   */
  private async executeTaskNonStreaming(
    client: ReturnType<typeof createOpencodeClient>,
    sessionId: string,
    taskId: string | undefined,
    promptOptions: {
      path: { id: string };
      body: {
        parts: Array<{ type: 'text'; text: string }>;
        model?: { providerID: string; modelID: string };
      };
    },
    opencodeSessionId: string,
    messageIndex?: number
  ): Promise<TaskResult> {
    const response = await client.session.prompt(promptOptions);

    if (response.error) {
      throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
    }

    console.log('[OpenCodeTool] Response received, parts count:', response.data.parts?.length || 0);
    console.log(
      '[OpenCodeTool] Part types:',
      response.data.parts?.map((p) => p.type).join(', ') || 'none'
    );

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
      // Extract text from all parts that have text content (text, reasoning, etc.)
      const textParts: string[] = [];
      for (const part of response.data.parts) {
        // biome-ignore lint/suspicious/noExplicitAny: Part types vary, check for text field at runtime
        if ('text' in part && typeof (part as any).text === 'string') {
          // biome-ignore lint/suspicious/noExplicitAny: Checked above
          textParts.push((part as any).text);
        }
      }
      responseText = textParts.join('\n');
      console.log('[OpenCodeTool] Extracted', textParts.length, 'text parts');

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

    // Create assistant message in Agor database with OpenCode metadata
    if (!this.messagesService) {
      throw new Error('Messages service not available');
    }

    // Use provided index or default to 0
    const assistantIndex = messageIndex ?? 0;

    const message = await this.messagesService.create({
      message_id: generateId() as MessageID,
      session_id: sessionId as SessionID,
      task_id: taskId as TaskID | undefined,
      type: 'assistant' as const,
      role: MessageRole.ASSISTANT,
      index: assistantIndex,
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
