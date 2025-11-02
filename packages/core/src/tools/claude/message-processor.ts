/**
 * SDK Message Processor
 *
 * Processes Claude Agent SDK messages and converts them into structured events
 * for consumption by ClaudePromptService and downstream persistence layers.
 *
 * Responsibilities:
 * - Handle all SDK message types with dedicated handlers
 * - Track conversation state (session ID, message counts, activity)
 * - Emit streaming events for real-time UI updates
 * - Yield structured events for database persistence
 */

import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from '@anthropic-ai/claude-agent-sdk/sdk';
import type { SessionID } from '../../types';
import { MessageRole } from '../../types';

/**
 * Content block interface for SDK messages
 */
interface ContentBlock {
  type: string;
  text?: string;
  is_error?: boolean;
  content?: unknown;
  tool_use_id?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Events yielded by the processor for upstream consumption
 */
export type ProcessedEvent =
  | {
      type: 'partial';
      textChunk: string;
      agentSessionId?: string;
      resolvedModel?: string;
    }
  | {
      type: 'thinking_partial';
      thinkingChunk: string;
      agentSessionId?: string;
    }
  | {
      type: 'complete';
      role: MessageRole.ASSISTANT | MessageRole.USER;
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
        signature?: string; // For thinking blocks
      }>;
      toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      agentSessionId?: string;
      resolvedModel?: string;
    }
  | {
      type: 'tool_start';
      toolName: string;
      toolUseId: string;
      agentSessionId?: string;
    }
  | {
      type: 'tool_complete';
      toolUseId: string;
      agentSessionId?: string;
    }
  | {
      type: 'message_start';
      agentSessionId?: string;
    }
  | {
      type: 'message_complete';
      agentSessionId?: string;
    }
  | {
      type: 'session_id_captured';
      agentSessionId: string;
    }
  | {
      type: 'result';
      subtype: string;
      duration_ms?: number;
      cost?: number;
      token_usage?: unknown;
      model_usage?: unknown; // Per-model breakdown with context window info
      agentSessionId?: string;
    }
  | {
      type: 'end';
      reason: 'result' | 'stop_requested' | 'timeout';
    };

/**
 * Processor options
 */
export interface ProcessorOptions {
  sessionId: SessionID;
  existingSdkSessionId?: string;
  enableTokenStreaming?: boolean;
  idleTimeoutMs?: number;
}

/**
 * Processor state
 */
interface ProcessorState {
  sessionId: SessionID;
  existingSdkSessionId?: string;
  capturedAgentSessionId?: string;
  messageCount: number;
  lastActivityTime: number;
  lastAssistantMessageTime: number;
  resolvedModel?: string;
  enableTokenStreaming: boolean;
  idleTimeoutMs: number;
  // Track current content blocks for tool_complete events
  contentBlockStack: Array<{
    index: number;
    type: 'text' | 'tool_use' | 'thinking';
    toolUseId?: string;
    toolName?: string;
  }>;
}

/**
 * SDK Message Processor
 *
 * Stateful processor that handles SDK messages and emits structured events.
 * Create one instance per query/conversation.
 */
export class SDKMessageProcessor {
  private state: ProcessorState;

  constructor(options: ProcessorOptions) {
    this.state = {
      sessionId: options.sessionId,
      existingSdkSessionId: options.existingSdkSessionId,
      capturedAgentSessionId: undefined,
      messageCount: 0,
      lastActivityTime: Date.now(),
      lastAssistantMessageTime: Date.now(),
      enableTokenStreaming: options.enableTokenStreaming ?? true,
      idleTimeoutMs: options.idleTimeoutMs ?? 30000, // 30s default
      contentBlockStack: [],
    };
  }

  /**
   * Process an SDK message and return 0 or more events
   *
   * @param msg - SDK message to process
   * @returns Array of events to yield upstream
   */
  async process(msg: SDKMessage): Promise<ProcessedEvent[]> {
    this.state.messageCount++;
    this.state.lastActivityTime = Date.now();

    // Log message type for debugging (sample every 10th to reduce verbosity)
    if (this.state.messageCount % 10 === 0) {
      console.debug(`📨 SDK message ${this.state.messageCount}: type=${msg.type}`);
    }

    // Add detailed logging for debugging SDK behavior
    if (process.env.DEBUG_SDK_MESSAGES === 'true') {
      console.log(`🔍 [DEBUG] Full SDK message ${this.state.messageCount}:`);
      console.log(JSON.stringify(msg, null, 2));
    }

    // Capture session ID from first message that has it
    if (!this.state.capturedAgentSessionId && 'session_id' in msg && msg.session_id) {
      const events = this.captureSessionId(msg.session_id);
      // Continue processing the message after capturing session ID
      const messageEvents = await this.routeMessage(msg);
      return [...events, ...messageEvents];
    }

    return this.routeMessage(msg);
  }

  /**
   * Check if processor has timed out due to inactivity
   * Uses lastActivityTime (updated on EVERY message) for proper moving anchor behavior
   */
  hasTimedOut(): boolean {
    const timeSinceLastActivity = Date.now() - this.state.lastActivityTime;
    return timeSinceLastActivity > this.state.idleTimeoutMs;
  }

  /**
   * Get current processor state (for debugging/monitoring)
   */
  getState(): Readonly<ProcessorState> {
    return { ...this.state };
  }

  /**
   * Route message to appropriate handler based on type
   */
  private async routeMessage(msg: SDKMessage): Promise<ProcessedEvent[]> {
    switch (msg.type) {
      case 'assistant':
        return this.handleAssistant(msg as SDKAssistantMessage);
      case 'user':
        return this.handleUser(msg as SDKUserMessage | SDKUserMessageReplay);
      case 'stream_event':
        return this.handleStreamEvent(msg as SDKPartialAssistantMessage);
      case 'result':
        return this.handleResult(msg as SDKResultMessage);
      case 'system':
        return this.handleSystem(msg as SDKSystemMessage | SDKCompactBoundaryMessage);
      default:
        return this.handleUnknown(msg);
    }
  }

  /**
   * Capture SDK session ID for conversation continuity
   */
  private captureSessionId(sessionId: string): ProcessedEvent[] {
    // Only capture if it's different from existing
    if (sessionId === this.state.existingSdkSessionId) {
      return []; // No event needed - already stored
    }

    this.state.capturedAgentSessionId = sessionId;
    console.log(`🔑 New Agent SDK session_id`);

    return [
      {
        type: 'session_id_captured',
        agentSessionId: sessionId,
      },
    ];
  }

  /**
   * Handle assistant messages (complete responses)
   */
  private handleAssistant(msg: SDKAssistantMessage): ProcessedEvent[] {
    this.state.lastAssistantMessageTime = Date.now();

    const contentBlocks = this.processContentBlocks(msg.message?.content);
    const toolUses = this.extractToolUses(contentBlocks);

    return [
      {
        type: 'complete',
        role: MessageRole.ASSISTANT,
        content: contentBlocks,
        toolUses: toolUses.length > 0 ? toolUses : undefined,
        agentSessionId: this.state.capturedAgentSessionId,
        resolvedModel: this.state.resolvedModel,
      },
    ];
  }

  /**
   * Handle user messages (including tool results)
   */
  private handleUser(msg: SDKUserMessage | SDKUserMessageReplay): ProcessedEvent[] {
    // Check if this is a replay message (already processed)
    if ('isReplay' in msg && msg.isReplay) {
      console.debug(`🔄 User message replay (uuid: ${msg.uuid?.substring(0, 8)})`);
      return []; // Skip replays - already in our database
    }

    const content = msg.message?.content;
    const uuid = 'uuid' in msg ? msg.uuid : undefined;

    // Check what type of content this user message has
    const hasToolResult =
      Array.isArray(content) && content.some((b: ContentBlock) => b.type === 'tool_result');
    const hasText = Array.isArray(content) && content.some((b: ContentBlock) => b.type === 'text');

    if (hasToolResult) {
      // Tool result messages - save to database for conversation continuity
      const toolResults = content.filter((b: ContentBlock) => b.type === 'tool_result');
      console.log(
        `🔧 SDK user message with ${toolResults.length} tool result(s) (uuid: ${uuid?.substring(0, 8)})`
      );

      toolResults.forEach((tr: ContentBlock, i: number) => {
        const preview =
          typeof tr.content === 'string'
            ? tr.content.substring(0, 100)
            : JSON.stringify(tr.content).substring(0, 100);
        console.log(`   Result ${i + 1}: ${tr.is_error ? '❌ ERROR' : '✅'} ${preview}`);
      });

      // Yield event to save tool results to database
      return [
        {
          type: 'complete',
          role: MessageRole.USER,
          content: content as ContentBlock[], // Tool result content
          toolUses: undefined,
          agentSessionId: this.state.capturedAgentSessionId,
          resolvedModel: this.state.resolvedModel,
        },
      ];
    } else if (hasText) {
      const textBlocks = content.filter((b: ContentBlock) => b.type === 'text');
      const textPreview = textBlocks[0]?.text?.substring(0, 100) || '';
      console.log(`👤 SDK user message (uuid: ${uuid?.substring(0, 8)}): "${textPreview}"`);

      // Regular user text messages - also save for completeness
      return [
        {
          type: 'complete',
          role: MessageRole.USER,
          content: content as ContentBlock[],
          toolUses: undefined,
          agentSessionId: this.state.capturedAgentSessionId,
          resolvedModel: this.state.resolvedModel,
        },
      ];
    } else {
      console.log(`👤 SDK user message (uuid: ${uuid?.substring(0, 8)})`);
      console.log(
        `   Content types:`,
        Array.isArray(content) ? content.map((b: ContentBlock) => b.type) : 'no content'
      );
      return []; // Unknown user message type - log only
    }
  }

  /**
   * Handle streaming events (partial messages)
   */
  private handleStreamEvent(msg: SDKPartialAssistantMessage): ProcessedEvent[] {
    if (!this.state.enableTokenStreaming) {
      return []; // Streaming disabled
    }

    const event = msg.event as { type?: string; [key: string]: unknown };
    const events: ProcessedEvent[] = [];

    // Message start event
    if (event?.type === 'message_start') {
      console.debug(`🎬 Message start`);
      events.push({
        type: 'message_start',
        agentSessionId: this.state.capturedAgentSessionId,
      });

      // Capture model from message_start event
      const message = event.message as { model?: string } | undefined;
      if (message?.model) {
        this.state.resolvedModel = message.model;
      }
    }

    // Content block start (text, tool use, or thinking)
    if (event?.type === 'content_block_start') {
      const block = event.content_block as
        | { type?: string; name?: string; id?: string }
        | undefined;
      const blockIndex = event.index as number;

      if (block?.type === 'tool_use') {
        const toolName = block.name as string;
        const toolId = block.id as string;
        console.debug(`🔧 Tool start: ${toolName} (${toolId})`);

        // Track this tool use block
        this.state.contentBlockStack.push({
          index: blockIndex,
          type: 'tool_use',
          toolUseId: toolId,
          toolName: toolName,
        });

        events.push({
          type: 'tool_start',
          toolName: toolName,
          toolUseId: toolId,
          agentSessionId: this.state.capturedAgentSessionId,
        });
      } else if (block?.type === 'thinking') {
        console.debug(`🧠 Thinking block start`);
        // Track thinking blocks
        this.state.contentBlockStack.push({
          index: blockIndex,
          type: 'thinking',
        });
      } else if (block?.type === 'text') {
        // Track text blocks too
        this.state.contentBlockStack.push({
          index: blockIndex,
          type: 'text',
        });
      }
    }

    // Content block delta (streaming text, tool input, or thinking)
    if (event?.type === 'content_block_delta') {
      const delta = event.delta as
        | { type?: string; text?: string; partial_json?: string; thinking?: string }
        | undefined;
      if (delta?.type === 'text_delta') {
        const textChunk = delta.text as string;
        events.push({
          type: 'partial',
          textChunk,
          agentSessionId: this.state.capturedAgentSessionId,
          resolvedModel: this.state.resolvedModel,
        });
      } else if (delta?.type === 'thinking_delta') {
        const thinkingChunk = delta.thinking as string;
        console.debug(`🧠 Thinking chunk: ${thinkingChunk.substring(0, 50)}...`);
        events.push({
          type: 'thinking_partial',
          thinkingChunk,
          agentSessionId: this.state.capturedAgentSessionId,
        });
      } else if (delta?.type === 'input_json_delta') {
        // Tool input is being streamed - log for now
        // Could emit tool_input_chunk event if we want to show tool args as they build
        const partialJson = delta.partial_json;
        if (partialJson) {
          console.debug(`🔧 Tool input chunk: ${partialJson.substring(0, 50)}...`);
        }
      }
    }

    // Content block stop
    if (event?.type === 'content_block_stop') {
      const blockIndex = event.index;

      // Find the block that just completed
      const completedBlock = this.state.contentBlockStack.find((b) => b.index === blockIndex);

      if (completedBlock?.type === 'tool_use') {
        console.debug(`🏁 Tool complete: ${completedBlock.toolName} (${completedBlock.toolUseId})`);
        events.push({
          type: 'tool_complete',
          toolUseId: completedBlock.toolUseId!,
          agentSessionId: this.state.capturedAgentSessionId,
        });
      } else if (completedBlock?.type === 'thinking') {
        console.debug(`🧠 Thinking block ${blockIndex} complete`);
      } else {
        console.debug(`🏁 Content block ${blockIndex} complete`);
      }

      // Remove from stack
      this.state.contentBlockStack = this.state.contentBlockStack.filter(
        (b) => b.index !== blockIndex
      );
    }

    // Message stop event
    if (event?.type === 'message_stop') {
      console.debug(`🏁 Message complete`);
      events.push({
        type: 'message_complete',
        agentSessionId: this.state.capturedAgentSessionId,
      });

      // Clear content block stack for next message
      this.state.contentBlockStack = [];
    }

    return events;
  }

  /**
   * Handle result messages (end of conversation)
   */
  private handleResult(msg: SDKResultMessage): ProcessedEvent[] {
    const subtype = msg.subtype || 'unknown';
    const duration = msg.duration_ms;
    const cost = msg.total_cost_usd;

    console.log(
      `✅ SDK result: ${subtype}${duration ? ` (${duration}ms)` : ''}${cost ? ` ($${cost})` : ''}`
    );

    // Log additional metadata if available
    if ('usage' in msg && msg.usage) {
      console.log(`   Token usage:`, msg.usage);
    }

    // Log modelUsage (should contain contextWindow per TypeScript types)
    if ('modelUsage' in msg && msg.modelUsage) {
      console.log(`   Model usage (with contextWindow):`, JSON.stringify(msg.modelUsage, null, 2));
    }

    return [
      {
        type: 'result',
        subtype,
        duration_ms: duration,
        cost,
        token_usage: 'usage' in msg ? msg.usage : undefined,
        model_usage: 'modelUsage' in msg ? msg.modelUsage : undefined,
        agentSessionId: this.state.capturedAgentSessionId,
      },
      {
        type: 'end',
        reason: 'result',
      },
    ];
  }

  /**
   * Handle system messages
   */
  private handleSystem(msg: SDKSystemMessage | SDKCompactBoundaryMessage): ProcessedEvent[] {
    if ('subtype' in msg && msg.subtype === 'compact_boundary') {
      console.debug(`📦 SDK compact boundary (memory management)`);
      return [];
    }

    if ('subtype' in msg && msg.subtype === 'init') {
      console.debug(`ℹ️  SDK system init:`, {
        model: msg.model,
        permissionMode: msg.permissionMode,
        cwd: msg.cwd,
        tools: msg.tools?.length,
        mcp_servers: msg.mcp_servers?.length,
      });

      // Capture model from init message
      if (msg.model) {
        this.state.resolvedModel = msg.model;
      }

      return [];
    }

    console.debug(`ℹ️  SDK system message:`, msg);
    return [];
  }

  /**
   * Handle unknown message types
   */
  private handleUnknown(msg: { type?: string; [key: string]: unknown }): ProcessedEvent[] {
    console.warn(`⚠️  Unknown SDK message type: ${msg.type}`, msg);
    return []; // Continue processing - don't fail on unknown types
  }

  /**
   * Process content blocks from SDK message
   */
  private processContentBlocks(content: ContentBlock[]): Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    signature?: string;
  }> {
    if (!Array.isArray(content)) {
      return [];
    }

    return content.map((block: ContentBlock) => {
      if (block.type === 'text') {
        return {
          type: 'text',
          text: block.text,
        };
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        };
      } else if (block.type === 'thinking') {
        return {
          type: 'thinking',
          text: block.text,
          signature: block.signature as string | undefined, // Cryptographic signature for verification
        };
      } else {
        // Return block as-is for other types (tool_result, etc.)
        return {
          ...block,
          type: block.type,
        };
      }
    });
  }

  /**
   * Extract tool uses from content blocks
   */
  private extractToolUses(
    contentBlocks: Array<{
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>
  ): Array<{ id: string; name: string; input: Record<string, unknown> }> {
    return contentBlocks
      .filter((block) => block.type === 'tool_use' && block.id && block.name && block.input)
      .map((block) => ({
        id: block.id!,
        name: block.name!,
        input: block.input!,
      }));
  }
}
