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

import {
  SUPPRESSED_CLAUDE_STATUSES,
  SUPPRESSED_CLAUDE_SYSTEM_SUBTYPES,
} from '@agor/core/client/claude-system-suppression';
import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from '@agor/core/sdk';
import type { SessionID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';

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
      type: 'thinking_complete';
      agentSessionId?: string;
    }
  | {
      type: 'complete';
      role: MessageRole.ASSISTANT | MessageRole.USER | MessageRole.SYSTEM;
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
        status?: string; // For system_status blocks
      }>;
      toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      parent_tool_use_id?: string | null;
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
      raw_sdk_message: SDKResultMessage; // Pass the entire SDK message unchanged
      agentSessionId?: string;
    }
  | {
      type: 'system_complete';
      systemType: string;
      agentSessionId?: string;
      metadata?: {
        trigger?: 'manual' | 'auto';
        pre_tokens?: number;
      };
    }
  | {
      type: 'slash_commands_discovered';
      slashCommands: string[];
      skills: string[];
      agentSessionId?: string;
    }
  | {
      type: 'rate_limit';
      status: 'allowed' | 'allowed_warning' | 'rejected';
      resetsAt?: number;
      rateLimitType?: string;
      overageStatus?: string;
      isUsingOverage?: boolean;
      agentSessionId?: string;
    }
  | {
      type: 'sdk_event';
      sdkType: string;
      sdkSubtype?: string;
      summary: string;
      rawMessage: Record<string, unknown>;
      agentSessionId?: string;
    }
  | {
      type: 'context_usage';
      /** Raw response from SDK getContextUsage() — authoritative context window snapshot */
      contextUsage: import('@agor/core/sdk').SDKControlGetContextUsageResponse;
    }
  | {
      type: 'stopped';
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
  /**
   * Minimum chunk size in characters before emitting to prevent tiny/out-of-order chunks
   * @default 20
   */
  minChunkSize?: number;
}

/**
 * Streaming chunk configuration
 */
const DEFAULT_MIN_CHUNK_SIZE = 20; // Accumulate at least 20 chars before emitting

/**
 * Processor state
 */
interface ProcessorState {
  sessionId: SessionID;
  existingSdkSessionId?: string;
  capturedAgentSessionId?: string;
  messageCount: number;
  assistantMessageCount: number;
  lastActivityTime: number;
  lastAssistantMessageTime: number;
  resolvedModel?: string;
  enableTokenStreaming: boolean;
  idleTimeoutMs: number;
  minChunkSize: number;
  // Track current content blocks for tool_complete events
  contentBlockStack: Array<{
    index: number;
    type: 'text' | 'tool_use' | 'thinking';
    toolUseId?: string;
    toolName?: string;
  }>;
  // Text chunk accumulation buffer
  textChunkBuffer: string;
  textChunkBufferSize: number;
  // Available slash commands and skills (captured from init message)
  slashCommands: string[];
  skills: string[];
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
      assistantMessageCount: 0,
      lastActivityTime: Date.now(),
      lastAssistantMessageTime: Date.now(),
      enableTokenStreaming: options.enableTokenStreaming ?? true,
      idleTimeoutMs: options.idleTimeoutMs ?? 30000, // 30s default
      minChunkSize: options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE,
      contentBlockStack: [],
      textChunkBuffer: '',
      textChunkBufferSize: 0,
      slashCommands: [],
      skills: [],
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

    // Log message type for debugging (skip stream_event as it's too verbose)
    if (this.state.messageCount % 10 === 0 && msg.type !== 'stream_event') {
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
      case 'rate_limit_event':
        return this.handleRateLimitEvent(
          msg as { type: string; rate_limit_info?: Record<string, unknown> }
        );
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
    this.state.assistantMessageCount++;

    const contentBlocks = this.processContentBlocks(msg.message?.content as ContentBlock[]);
    const toolUses = this.extractToolUses(contentBlocks);

    return [
      {
        type: 'complete',
        role: MessageRole.ASSISTANT,
        content: contentBlocks,
        toolUses: toolUses.length > 0 ? toolUses : undefined,
        parent_tool_use_id: msg.parent_tool_use_id || null,
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

    const content = msg.message?.content as ContentBlock[] | undefined;
    const uuid = 'uuid' in msg ? msg.uuid : undefined;

    // Check what type of content this user message has
    const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result');
    const hasText = Array.isArray(content) && content.some((b) => b.type === 'text');

    if (hasToolResult) {
      // Tool result messages - save to database for conversation continuity
      const toolResults = content.filter((b) => b.type === 'tool_result');
      const errorCount = toolResults.filter((tr) => tr.is_error).length;
      const successCount = toolResults.length - errorCount;
      console.log(
        `🔧 SDK user message with ${toolResults.length} tool result(s) (✅ ${successCount}, ❌ ${errorCount})`
      );

      // Yield event to save tool results to database
      return [
        {
          type: 'complete',
          role: MessageRole.USER,
          content: content, // Tool result content
          toolUses: undefined,
          parent_tool_use_id: msg.parent_tool_use_id || null,
          agentSessionId: this.state.capturedAgentSessionId,
          resolvedModel: this.state.resolvedModel,
        },
      ];
    } else if (hasText) {
      const textBlocks = content.filter((b) => b.type === 'text');
      const textPreview = textBlocks[0]?.text?.substring(0, 100) || '';
      console.log(`👤 SDK user message (uuid: ${uuid?.substring(0, 8)}): "${textPreview}"`);

      // Regular user text messages - also save for completeness
      return [
        {
          type: 'complete',
          role: MessageRole.USER,
          content: content,
          toolUses: undefined,
          parent_tool_use_id: msg.parent_tool_use_id || null,
          agentSessionId: this.state.capturedAgentSessionId,
          resolvedModel: this.state.resolvedModel,
        },
      ];
    } else {
      console.log(`👤 SDK user message (uuid: ${uuid?.substring(0, 8)})`);
      console.log(
        `   Content types:`,
        Array.isArray(content) ? content.map((b) => b.type) : 'no content'
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

        // Accumulate chunk in buffer
        this.state.textChunkBuffer += textChunk;
        this.state.textChunkBufferSize += textChunk.length;

        // Emit buffered chunk if we've reached minimum size
        if (this.state.textChunkBufferSize >= this.state.minChunkSize) {
          events.push({
            type: 'partial',
            textChunk: this.state.textChunkBuffer,
            agentSessionId: this.state.capturedAgentSessionId,
            resolvedModel: this.state.resolvedModel,
          });

          // Reset buffer after emitting
          this.state.textChunkBuffer = '';
          this.state.textChunkBufferSize = 0;
        }
        // Otherwise, chunk is buffered and will be emitted later
      } else if (delta?.type === 'thinking_delta') {
        const thinkingChunk = delta.thinking as string;
        events.push({
          type: 'thinking_partial',
          thinkingChunk,
          agentSessionId: this.state.capturedAgentSessionId,
        });
      } else if (delta?.type === 'input_json_delta') {
        // Tool input is being streamed (no logging - reduces noise)
        // Could emit tool_input_chunk event if we want to show tool args as they build
      }
    }

    // Content block stop
    if (event?.type === 'content_block_stop') {
      const blockIndex = event.index;

      // Find the block that just completed
      const completedBlock = this.state.contentBlockStack.find((b) => b.index === blockIndex);

      if (completedBlock?.type === 'tool_use') {
        events.push({
          type: 'tool_complete',
          toolUseId: completedBlock.toolUseId!,
          agentSessionId: this.state.capturedAgentSessionId,
        });
      } else if (completedBlock?.type === 'thinking') {
        events.push({
          type: 'thinking_complete',
          agentSessionId: this.state.capturedAgentSessionId,
        });
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

      // Clear content block stack and buffer for next message
      // Note: Any unbuffered text will be in the complete message (safety net)
      this.state.contentBlockStack = [];
      this.state.textChunkBuffer = '';
      this.state.textChunkBufferSize = 0;
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

    const events: ProcessedEvent[] = [];

    // The SDK puts final output text in result.result for both normal prompts and local commands.
    // For local commands (e.g. /usage, /cost), this is the ONLY output (no assistant messages).
    // For normal prompts, assistant messages are already streamed separately.
    // We emit result text as a system message when no assistant messages were produced.
    if (
      msg.subtype === 'success' &&
      'result' in msg &&
      msg.result &&
      typeof msg.result === 'string' &&
      msg.result.trim().length > 0
    ) {
      const hasAssistantMessages = this.state.assistantMessageCount > 0;
      console.log(
        `📋 SDK result text (${msg.result.length} chars, hasAssistantMessages=${hasAssistantMessages})`
      );
      if (!hasAssistantMessages) {
        events.push({
          type: 'complete',
          role: MessageRole.ASSISTANT,
          content: [
            {
              type: 'text',
              text: msg.result,
            },
          ],
          toolUses: undefined,
          parent_tool_use_id: null,
          agentSessionId: this.state.capturedAgentSessionId,
          resolvedModel: this.state.resolvedModel,
        });
      }
    }

    events.push(
      {
        type: 'result',
        raw_sdk_message: msg, // Pass the entire SDK message unchanged
        agentSessionId: this.state.capturedAgentSessionId,
      },
      {
        type: 'end',
        reason: 'result',
      }
    );

    return events;
  }

  /**
   * Handle system messages
   */
  private handleSystem(msg: SDKSystemMessage | SDKCompactBoundaryMessage): ProcessedEvent[] {
    if ('subtype' in msg && msg.subtype === 'compact_boundary') {
      console.log(`📦 SDK compact_boundary (compaction finished)`);
      console.log(`📊 Full compact_boundary message:`, JSON.stringify(msg, null, 2));

      // Extract metadata from compact_boundary message
      const metadata = 'compact_metadata' in msg ? msg.compact_metadata : undefined;

      // Emit event to mark compaction as complete with full metadata
      return [
        {
          type: 'system_complete',
          systemType: 'compaction',
          agentSessionId: this.state.capturedAgentSessionId,
          metadata: metadata
            ? {
                trigger: metadata.trigger,
                pre_tokens: metadata.pre_tokens,
              }
            : undefined,
        },
      ];
    }

    // Handle status='compacting' - check before 'init' to avoid type narrowing issues
    if ('status' in msg && msg.status === 'compacting') {
      console.log(`🗜️  SDK compacting context...`);
      return [
        {
          type: 'complete',
          role: MessageRole.SYSTEM,
          content: [
            {
              type: 'system_status',
              status: 'compacting',
              text: 'Compacting conversation context...',
            },
          ],
          toolUses: undefined,
          parent_tool_use_id: null,
          agentSessionId: this.state.capturedAgentSessionId,
          resolvedModel: this.state.resolvedModel,
        },
      ];
    }

    // Suppress noisy status values (e.g. 'requesting' — fires on every API call).
    // Other status variants (null, permissionMode change, compact_result/error) still
    // flow through and get surfaced as generic sdk_event messages below.
    if (
      'status' in msg &&
      typeof msg.status === 'string' &&
      (SUPPRESSED_CLAUDE_STATUSES as ReadonlySet<string>).has(msg.status)
    ) {
      return [];
    }

    if ('subtype' in msg && msg.subtype === 'init') {
      const initMsg = msg as SDKSystemMessage;
      console.debug(`ℹ️  SDK system init:`, {
        model: initMsg.model,
        permissionMode: initMsg.permissionMode,
        cwd: initMsg.cwd,
        tools: initMsg.tools?.length,
        mcp_servers: initMsg.mcp_servers?.length,
        slash_commands: initMsg.slash_commands?.length,
        skills: initMsg.skills?.length,
      });

      const events: ProcessedEvent[] = [];

      // Capture model from init message
      if (initMsg.model) {
        this.state.resolvedModel = initMsg.model;
      }

      // Capture available slash commands and skills for autocomplete
      if (initMsg.slash_commands || initMsg.skills) {
        this.state.slashCommands = initMsg.slash_commands || [];
        this.state.skills = initMsg.skills || [];
        console.log(
          `📋 Available commands: ${this.state.slashCommands.length} slash commands, ${this.state.skills.length} skills`
        );

        // Emit event so claude-tool can persist to session for UI autocomplete
        events.push({
          type: 'slash_commands_discovered',
          slashCommands: this.state.slashCommands,
          skills: this.state.skills,
          agentSessionId: this.state.capturedAgentSessionId,
        });
      }

      return events;
    }

    // Blacklist approach: surface unhandled system subtypes by default
    const subtype =
      ('subtype' in msg ? (msg as { subtype?: string }).subtype : undefined) || 'unknown';

    if ((SUPPRESSED_CLAUDE_SYSTEM_SUBTYPES as ReadonlySet<string>).has(subtype)) {
      console.debug(`🔇 Suppressed system subtype: ${subtype}`);
      return [];
    }

    console.log(`📡 Surfacing unhandled system subtype: ${subtype}`);
    return [
      {
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: subtype,
        summary: this.summarizeMessage(msg as Record<string, unknown>),
        rawMessage: msg as Record<string, unknown>,
        agentSessionId: this.state.capturedAgentSessionId,
      },
    ];
  }

  /**
   * Handle rate_limit_event messages from the SDK
   *
   * SDK statuses (from SDKRateLimitInfo):
   * - 'allowed': Normal, fires on every API call — never surfaced (too noisy)
   * - 'allowed_warning': Approaching rate limit — always surface
   * - 'rejected': Hard blocked by rate limit — always surface
   */
  private handleRateLimitEvent(msg: {
    type: string;
    rate_limit_info?: Record<string, unknown>;
  }): ProcessedEvent[] {
    const info = msg.rate_limit_info || {};
    const status = (info.status as string) || 'unknown';
    const rateLimitType = info.rateLimitType as string | undefined;
    const resetsAt = info.resetsAt as number | undefined;
    const overageStatus = info.overageStatus as string | undefined;
    const isUsingOverage = info.isUsingOverage as boolean | undefined;

    // Always log rate limit events
    if (status === 'allowed') {
      console.log(
        `⏳ Rate limit event: allowed (type: ${rateLimitType || 'unknown'}, overage: ${overageStatus || 'unknown'})`
      );
    } else {
      console.warn(
        `🚫 Rate limit event: ${status} (type: ${rateLimitType || 'unknown'}, resets: ${resetsAt ? new Date(resetsAt * 1000).toISOString() : 'unknown'})`
      );
    }

    // Surface only events where the user is actually rate-limited or approaching a limit.
    // 'allowed' fires on every API call — never surface it, even if overageStatus is 'rejected',
    // because that just means the org doesn't have overage enabled (a permanent, non-actionable state).
    // 'allowed_warning' and 'rejected' always get surfaced since they indicate real throttling.
    const shouldSurface = status === 'allowed_warning' || status === 'rejected';

    if (shouldSurface) {
      return [
        {
          type: 'rate_limit',
          status,
          resetsAt,
          rateLimitType,
          overageStatus,
          isUsingOverage,
          agentSessionId: this.state.capturedAgentSessionId,
        },
      ];
    }

    return [];
  }

  /**
   * Message types to suppress (log-only, don't surface to users).
   * Everything NOT in this set is surfaced as a system message by default.
   */
  private static readonly SUPPRESSED_MESSAGE_TYPES = new Set([
    'tool_progress', // Fires constantly during tool execution — extremely noisy
    'prompt_suggestion', // End-of-conversation suggestions, not relevant in Agor
  ]);

  /**
   * Handle unknown/unhandled top-level message types.
   * Blacklist approach: surface everything by default, suppress only known-noisy types.
   */
  private handleUnknown(msg: { type?: string; [key: string]: unknown }): ProcessedEvent[] {
    const msgType = msg.type || 'unknown';

    if (SDKMessageProcessor.SUPPRESSED_MESSAGE_TYPES.has(msgType)) {
      console.debug(`🔇 Suppressed SDK message type: ${msgType}`);
      return [];
    }

    console.log(`📡 Surfacing unhandled SDK message type: ${msgType}`);
    return [
      {
        type: 'sdk_event',
        sdkType: msgType,
        summary: this.summarizeMessage(msg),
        rawMessage: msg as Record<string, unknown>,
        agentSessionId: this.state.capturedAgentSessionId,
      },
    ];
  }

  /**
   * Create a human-readable summary from an SDK message for display in the conversation UI.
   */
  private summarizeMessage(msg: Record<string, unknown>): string {
    const type = (msg.type as string) || 'unknown';
    const subtype = msg.subtype as string | undefined;
    const label = subtype ? `${type}/${subtype}` : type;

    // Type-specific summaries for known unhandled types
    if (type === 'api_retry') {
      const attempt = msg.attempt as number | undefined;
      const maxRetries = msg.max_retries as number | undefined;
      const delayMs = msg.retry_delay_ms as number | undefined;
      const errorStatus = msg.error_status as number | undefined;
      const parts = [`API retry attempt ${attempt ?? '?'}/${maxRetries ?? '?'}`];
      if (errorStatus) parts.push(`(HTTP ${errorStatus})`);
      if (delayMs) parts.push(`— waiting ${Math.round(delayMs / 1000)}s`);
      return parts.join(' ');
    }

    if (type === 'auth_status') {
      const isAuth = msg.isAuthenticating as boolean | undefined;
      const error = msg.error as string | undefined;
      if (error) return `Authentication error: ${error}`;
      return isAuth ? 'Authenticating...' : 'Authentication complete';
    }

    if (type === 'tool_use_summary') {
      return (msg.summary as string) || 'Tool use summary';
    }

    if (subtype === 'api_retry') {
      const attempt = msg.attempt as number | undefined;
      const maxRetries = msg.max_retries as number | undefined;
      const delayMs = msg.retry_delay_ms as number | undefined;
      const parts = [`API retry ${attempt ?? '?'}/${maxRetries ?? '?'}`];
      if (delayMs) parts.push(`— waiting ${Math.round(delayMs / 1000)}s`);
      return parts.join(' ');
    }

    if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'hook_response') {
      return `Hook: ${subtype.replace('hook_', '')}`;
    }

    if (
      subtype === 'task_notification' ||
      subtype === 'task_started' ||
      subtype === 'task_progress'
    ) {
      return `Task: ${subtype.replace('task_', '')}`;
    }

    if (subtype === 'local_command_output') {
      return 'Local command output';
    }

    if (subtype === 'status') {
      const status = msg.status as string | undefined;
      return status ? `Status: ${status}` : 'Status update';
    }

    // Generic fallback
    return `SDK event: ${label}`;
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
