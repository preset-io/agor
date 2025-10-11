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
import { generateId } from '../../db/ids';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { Message, MessageID, SessionID, TaskID, ToolUse } from '../../types';
import type { ImportOptions, ITool, SessionData, ToolCapabilities } from '../base';
import { loadClaudeSession } from './import/load-session';
import { transcriptsToMessages } from './import/message-converter';
import { ClaudePromptService } from './prompt-service';

/**
 * Service interface for creating messages via FeathersJS
 * This ensures WebSocket events are emitted when messages are created
 */
export interface MessagesService {
  create(data: Partial<Message>): Promise<Message>;
}

export class ClaudeTool implements ITool {
  readonly toolType = 'claude-code' as const;
  readonly name = 'Claude Code';

  private promptService?: ClaudePromptService;

  constructor(
    private messagesRepo?: MessagesRepository,
    private sessionsRepo?: SessionRepository,
    private apiKey?: string,
    private messagesService?: MessagesService,
    private sessionMCPRepo?: SessionMCPServerRepository
  ) {
    if (messagesRepo && sessionsRepo) {
      this.promptService = new ClaudePromptService(
        messagesRepo,
        sessionsRepo,
        apiKey,
        sessionMCPRepo
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
      supportsStreaming: false, // Returns complete messages
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
      status: 'completed' as const, // Historical sessions are always completed
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
   * Execute a prompt against a session
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
    taskId?: TaskID
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

    // Create user message immediately via FeathersJS service (emits WebSocket event)
    const userMessage: Message = {
      message_id: generateId() as MessageID,
      session_id: sessionId,
      type: 'user',
      role: 'user',
      index: nextIndex++,
      timestamp: new Date().toISOString(),
      content_preview: prompt.substring(0, 200),
      content: prompt,
      task_id: taskId, // Link to task immediately
    };

    await this.messagesService.create(userMessage);

    // Execute prompt via Agent SDK with progressive message creation
    // As each assistant message arrives, create it immediately (sends WebSocket event)
    const assistantMessageIds: MessageID[] = [];
    const inputTokens = 0;
    const outputTokens = 0;
    let capturedAgentSessionId: string | undefined;

    for await (const assistantMsg of this.promptService.promptSessionStreaming(sessionId, prompt)) {
      // Capture Agent SDK session_id from first message
      if (!capturedAgentSessionId && assistantMsg.agentSessionId) {
        capturedAgentSessionId = assistantMsg.agentSessionId;
        console.log(
          `🔑 Captured Agent SDK session_id for Agor session ${sessionId}: ${capturedAgentSessionId}`
        );

        // Store it in the session for future prompts
        if (this.sessionsRepo) {
          await this.sessionsRepo.update(sessionId, { agent_session_id: capturedAgentSessionId });
          console.log(`💾 Stored Agent SDK session_id in Agor session`);
        }
      }

      // Generate content preview from text blocks
      const textBlocks = assistantMsg.content.filter(b => b.type === 'text').map(b => b.text);
      const contentPreview = textBlocks.join('').substring(0, 200);

      const message: Message = {
        message_id: generateId() as MessageID,
        session_id: sessionId,
        type: 'assistant',
        role: 'assistant',
        index: nextIndex++,
        timestamp: new Date().toISOString(),
        content_preview: contentPreview,
        content: assistantMsg.content as Message['content'], // ContentBlock[] array
        tool_uses: assistantMsg.toolUses,
        task_id: taskId, // Link to task immediately so UI can display progressively
        metadata: {
          model: 'claude-sonnet-4-5-20250929',
          tokens: {
            input: inputTokens,
            output: outputTokens,
          },
        },
      };

      await this.messagesService.create(message);
      assistantMessageIds.push(message.message_id);
    }

    return {
      userMessageId: userMessage.message_id,
      assistantMessageIds,
    };
  }
}
