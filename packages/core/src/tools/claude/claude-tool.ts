/**
 * Claude Code Tool Implementation
 *
 * Current capabilities:
 * - ✅ Import sessions from transcript files
 * - ✅ Live execution via Anthropic SDK
 * - ❌ Create new sessions (waiting for SDK)
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { generateId } from '../../db/ids';
import type { MCPServerRepository } from '../../db/repositories/mcp-servers';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { PermissionService } from '../../permissions/permission-service';
import type { Message, MessageID, SessionID, TaskID } from '../../types';
import { TaskStatus } from '../../types';
import type { ImportOptions, ITool, SessionData, ToolCapabilities } from '../base';
import { loadClaudeSession } from './import/load-session';
import { transcriptsToMessages } from './import/message-converter';
import { DEFAULT_CLAUDE_MODEL } from './models';
import { ClaudePromptService } from './prompt-service';

/**
 * Service interface for creating messages via FeathersJS
 * This ensures WebSocket events are emitted when messages are created
 */
export interface MessagesService {
  create(data: Partial<Message>): Promise<Message>;
}

/**
 * Service interface for updating tasks via FeathersJS
 * This ensures WebSocket events are emitted when tasks are updated
 */
export interface TasksService {
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service returns dynamic task data
  get(id: string): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service accepts partial task updates
  patch(id: string, data: Partial<any>): Promise<any>;
}

/**
 * Service interface for updating sessions via FeathersJS
 * This ensures WebSocket events are emitted when sessions are updated (e.g., permission config)
 */
export interface SessionsService {
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service accepts partial session updates
  patch(id: string, data: Partial<any>): Promise<any>;
}

export class ClaudeTool implements ITool {
  readonly toolType = 'claude-code' as const;
  readonly name = 'Claude Code';

  private promptService?: ClaudePromptService;

  constructor(
    private messagesRepo?: MessagesRepository,
    private sessionsRepo?: SessionRepository,
    apiKey?: string,
    private messagesService?: MessagesService,
    sessionMCPRepo?: SessionMCPServerRepository,
    mcpServerRepo?: MCPServerRepository,
    permissionService?: PermissionService,
    private tasksService?: TasksService,
    sessionsService?: SessionsService
  ) {
    if (messagesRepo && sessionsRepo) {
      this.promptService = new ClaudePromptService(
        messagesRepo,
        sessionsRepo,
        apiKey,
        sessionMCPRepo,
        mcpServerRepo,
        permissionService,
        tasksService,
        sessionsService
      );
    }
  }

  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: true, // ✅ We have transcript parsing
      supportsSessionCreate: false, // ❌ Waiting for SDK
      supportsLiveExecution: true, // ✅ Now supported via Anthropic SDK
      supportsSessionFork: false,
      supportsChildSpawn: false,
      supportsGitState: true, // Transcripts contain git state
      supportsStreaming: true, // ✅ Streaming via callbacks during message generation
    };
  }

  async checkInstalled(): Promise<boolean> {
    try {
      // Check if ~/.claude directory exists
      const claudeDir = path.join(os.homedir(), '.claude');
      const stats = await fs.stat(claudeDir);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  async importSession(sessionId: string, options?: ImportOptions): Promise<SessionData> {
    // Load session using existing transcript parser
    const session = await loadClaudeSession(sessionId, options?.projectDir);

    // Convert messages to Agor format
    const messages = transcriptsToMessages(session.messages, session.sessionId as SessionID);

    // Extract metadata
    const metadata = {
      sessionId: session.sessionId,
      toolType: this.toolType,
      status: TaskStatus.COMPLETED, // Historical sessions are always completed
      createdAt: new Date(session.messages[0]?.timestamp || Date.now()),
      lastUpdatedAt: new Date(
        session.messages[session.messages.length - 1]?.timestamp || Date.now()
      ),
      workingDirectory: session.cwd || undefined,
      messageCount: session.messages.length,
    };

    return {
      sessionId: session.sessionId,
      toolType: this.toolType,
      messages,
      metadata,
      workingDirectory: session.cwd || undefined,
    };
  }

  /**
   * Execute a prompt against a session WITH real-time streaming
   *
   * Creates user message, streams response chunks from Claude, then creates complete assistant messages.
   * Calls streamingCallbacks during message generation for real-time UI updates.
   * Agent SDK may return multiple assistant messages (e.g., tool invocation, then response).
   *
   * @param sessionId - Session to execute prompt in
   * @param prompt - User prompt text
   * @param taskId - Optional task ID for linking messages
   * @param permissionMode - Optional permission mode for SDK
   * @param streamingCallbacks - Optional callbacks for real-time streaming (enables typewriter effect)
   * @returns User message ID and array of assistant message IDs
   */
  async executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    streamingCallbacks?: import('../base').StreamingCallbacks
  ): Promise<{ userMessageId: MessageID; assistantMessageIds: MessageID[] }> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('ClaudeTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('ClaudeTool not initialized with messagesService for live execution');
    }

    // Get next message index
    const existingMessages = await this.messagesRepo.findBySessionId(sessionId);
    let nextIndex = existingMessages.length;

    // Create user message
    const userMessage = await this.createUserMessage(sessionId, prompt, taskId, nextIndex++);

    // Execute prompt via Agent SDK with streaming
    const assistantMessageIds: MessageID[] = [];
    let capturedAgentSessionId: string | undefined;
    let resolvedModel: string | undefined;
    let currentMessageId: MessageID | null = null;
    let streamStartTime = Date.now();
    let firstTokenTime: number | null = null;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      // Capture resolved model from first event
      if (!resolvedModel && event.resolvedModel) {
        resolvedModel = event.resolvedModel;
      }

      // Capture Agent SDK session_id
      if (!capturedAgentSessionId && event.agentSessionId) {
        capturedAgentSessionId = event.agentSessionId;
        await this.captureAgentSessionId(sessionId, capturedAgentSessionId);
      }

      // Handle partial streaming events (token-level chunks)
      if (event.type === 'partial' && event.textChunk) {
        // Start new message if needed
        if (!currentMessageId) {
          currentMessageId = generateId() as MessageID;
          firstTokenTime = Date.now();
          const ttfb = firstTokenTime - streamStartTime;
          console.debug(`⏱️ [SDK] TTFB: ${ttfb}ms`);

          if (streamingCallbacks) {
            streamingCallbacks.onStreamStart(currentMessageId, {
              session_id: sessionId,
              task_id: taskId,
              role: 'assistant',
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Emit chunk immediately (no artificial delays - true streaming!)
        if (streamingCallbacks) {
          streamingCallbacks.onStreamChunk(currentMessageId, event.textChunk);
        }
      }
      // Handle complete message (save to database)
      else if (event.type === 'complete' && event.content) {
        // End streaming if active
        if (currentMessageId && streamingCallbacks) {
          const streamEndTime = Date.now();
          streamingCallbacks.onStreamEnd(currentMessageId);
          const totalTime = streamEndTime - streamStartTime;
          const streamingTime = firstTokenTime ? streamEndTime - firstTokenTime : 0;
          console.debug(
            `⏱️ [Streaming] Complete - TTFB: ${firstTokenTime ? firstTokenTime - streamStartTime : 0}ms, streaming: ${streamingTime}ms, total: ${totalTime}ms`
          );
        }

        // Use existing message ID or generate new one
        const assistantMessageId = currentMessageId || (generateId() as MessageID);

        // Create complete message in DB
        await this.createAssistantMessage(
          sessionId,
          assistantMessageId,
          event.content,
          event.toolUses,
          taskId,
          nextIndex++,
          resolvedModel
        );
        assistantMessageIds.push(assistantMessageId);

        // Reset for next message
        currentMessageId = null;
        streamStartTime = Date.now();
        firstTokenTime = null;
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
    };
  }

  /**
   * Create user message in database
   * @private
   */
  private async createUserMessage(
    sessionId: SessionID,
    prompt: string,
    taskId: TaskID | undefined,
    nextIndex: number
  ): Promise<Message> {
    const userMessage: Message = {
      message_id: generateId() as MessageID,
      session_id: sessionId,
      type: 'user',
      role: 'user',
      index: nextIndex,
      timestamp: new Date().toISOString(),
      content_preview: prompt.substring(0, 200),
      content: prompt,
      task_id: taskId,
    };

    await this.messagesService?.create(userMessage);
    return userMessage;
  }

  /**
   * Capture and store Agent SDK session_id for conversation continuity
   * @private
   */
  private async captureAgentSessionId(sessionId: SessionID, agentSessionId: string): Promise<void> {
    console.log(
      `🔑 Captured Agent SDK session_id for Agor session ${sessionId}: ${agentSessionId}`
    );

    if (this.sessionsRepo) {
      console.log(
        `📝 About to update session with: ${JSON.stringify({ sdk_session_id: agentSessionId })}`
      );
      const updated = await this.sessionsRepo.update(sessionId, {
        sdk_session_id: agentSessionId,
      });
      console.log(`💾 Stored Agent SDK session_id in Agor session`);
      console.log(`🔍 Verify: updated.sdk_session_id = ${updated.sdk_session_id}`);
    }
  }

  /**
   * Create complete assistant message in database
   * @private
   */
  private async createAssistantMessage(
    sessionId: SessionID,
    messageId: MessageID,
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>,
    toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> | undefined,
    taskId: TaskID | undefined,
    nextIndex: number,
    resolvedModel?: string
  ): Promise<Message> {
    // Extract text content for preview
    const textBlocks = content.filter(b => b.type === 'text').map(b => b.text || '');
    const fullTextContent = textBlocks.join('');
    const contentPreview = fullTextContent.substring(0, 200);

    const message: Message = {
      message_id: messageId,
      session_id: sessionId,
      type: 'assistant',
      role: 'assistant',
      index: nextIndex,
      timestamp: new Date().toISOString(),
      content_preview: contentPreview,
      content: content as Message['content'],
      tool_uses: toolUses,
      task_id: taskId,
      metadata: {
        model: resolvedModel || DEFAULT_CLAUDE_MODEL,
        tokens: {
          input: 0, // TODO: Extract from SDK
          output: 0,
        },
      },
    };

    await this.messagesService?.create(message);

    // If task exists, update it with resolved model
    if (taskId && resolvedModel && this.tasksService) {
      await this.tasksService.patch(taskId, { model: resolvedModel });
    }

    return message;
  }

  /**
   * Execute a prompt against a session (non-streaming version)
   *
   * Creates user message, streams response from Claude, creates assistant messages.
   * Agent SDK may return multiple assistant messages (e.g., tool invocation, then response).
   * Returns user message ID and array of assistant message IDs.
   *
   * Also captures and stores the Agent SDK session_id for conversation continuity.
   */
  async executePrompt(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode
  ): Promise<{ userMessageId: MessageID; assistantMessageIds: MessageID[] }> {
    if (!this.promptService || !this.messagesRepo) {
      throw new Error('ClaudeTool not initialized with repositories for live execution');
    }

    if (!this.messagesService) {
      throw new Error('ClaudeTool not initialized with messagesService for live execution');
    }

    // Get next message index
    const existingMessages = await this.messagesRepo.findBySessionId(sessionId);
    let nextIndex = existingMessages.length;

    // Create user message
    const userMessage = await this.createUserMessage(sessionId, prompt, taskId, nextIndex++);

    // Execute prompt via Agent SDK
    const assistantMessageIds: MessageID[] = [];
    let capturedAgentSessionId: string | undefined;
    let resolvedModel: string | undefined;

    for await (const event of this.promptService.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      // Capture resolved model from first event
      if (!resolvedModel && event.resolvedModel) {
        resolvedModel = event.resolvedModel;
      }

      // Capture Agent SDK session_id
      if (!capturedAgentSessionId && event.agentSessionId) {
        capturedAgentSessionId = event.agentSessionId;
        await this.captureAgentSessionId(sessionId, capturedAgentSessionId);
      }

      // Skip partial events in non-streaming mode
      if (event.type === 'partial') {
        continue;
      }

      // Handle complete messages only
      if (event.type === 'complete' && event.content) {
        const messageId = generateId() as MessageID;
        await this.createAssistantMessage(
          sessionId,
          messageId,
          event.content,
          event.toolUses,
          taskId,
          nextIndex++,
          resolvedModel
        );
        assistantMessageIds.push(messageId);
      }
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
    };
  }

  /**
   * Stop currently executing task in session
   *
   * Uses Claude Agent SDK's native interrupt() method to gracefully stop execution.
   *
   * @param sessionId - Session identifier
   * @param taskId - Optional task ID (not used for Claude, session-level stop)
   * @returns Success status and reason if failed
   */
  async stopTask(
    sessionId: string,
    taskId?: string
  ): Promise<{
    success: boolean;
    partialResult?: Partial<{ taskId: string; status: 'completed' | 'failed' | 'cancelled' }>;
    reason?: string;
  }> {
    if (!this.promptService) {
      return {
        success: false,
        reason: 'ClaudeTool not initialized with prompt service',
      };
    }

    const result = await this.promptService.stopTask(sessionId as SessionID);

    if (result.success) {
      return {
        success: true,
        partialResult: {
          taskId: taskId || 'unknown',
          status: 'cancelled',
        },
      };
    }

    return result;
  }
}
