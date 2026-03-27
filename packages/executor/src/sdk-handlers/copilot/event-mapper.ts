/**
 * Copilot Event Mapper
 *
 * Maps Copilot SDK events to Agor's streaming callback interface.
 *
 * Copilot SDK emits 40+ typed events organized by category:
 * - assistant.*: Message content, reasoning, usage
 * - tool.*: Tool execution lifecycle
 * - session.*: Session state changes
 * - permission.*: Permission request/completion
 * - subagent.*: Sub-agent orchestration
 * - user_input.*: User input requests
 *
 * This mapper wires the relevant events to StreamingCallbacks for real-time UI updates.
 */

import type { MessageID, SessionID, TaskID } from '../../types.js';
import { MessageRole } from '../../types.js';
import type { StreamingCallbacks } from '../base/index.js';

/**
 * Copilot SDK session interface (from @github/copilot-sdk)
 *
 * Minimal type definition for the events we consume.
 * The full CopilotSession type comes from the SDK.
 */
export interface CopilotSessionEvents {
  on(
    event: 'assistant.message_delta',
    handler: (e: { data: { deltaContent: string } }) => void
  ): void;
  on(
    event: 'assistant.reasoning_delta',
    handler: (e: { data: { deltaContent: string } }) => void
  ): void;
  on(event: 'assistant.turn_start', handler: (e: unknown) => void): void;
  on(event: 'assistant.turn_end', handler: (e: unknown) => void): void;
  on(event: 'assistant.usage', handler: (e: { data: CopilotUsageData }) => void): void;
  on(event: 'tool.execution_start', handler: (e: { data: CopilotToolStartData }) => void): void;
  on(
    event: 'tool.execution_complete',
    handler: (e: { data: CopilotToolCompleteData }) => void
  ): void;
  on(event: 'session.idle', handler: () => void): void;
  on(event: 'session.error', handler: (e: { error: Error }) => void): void;
  on(event: 'subagent.started', handler: (e: { data: CopilotSubagentData }) => void): void;
  on(event: 'subagent.completed', handler: (e: { data: CopilotSubagentData }) => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * Copilot usage data from assistant.usage events
 */
export interface CopilotUsageData {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  model?: string;
}

/**
 * Copilot tool start event data
 */
export interface CopilotToolStartData {
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  mcpServerName?: string;
  mcpToolName?: string;
}

/**
 * Copilot tool complete event data
 */
export interface CopilotToolCompleteData {
  toolCallId: string;
  toolName: string;
  output?: string;
  status?: 'success' | 'error';
  mcpServerName?: string;
  mcpToolName?: string;
}

/**
 * Copilot sub-agent event data
 */
export interface CopilotSubagentData {
  agentName: string;
  toolCallId?: string;
  prompt?: string;
  result?: string;
}

/**
 * Accumulated usage from Copilot events
 */
export interface AccumulatedCopilotUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  model?: string;
}

/**
 * Collected tool use from Copilot events
 */
export interface CollectedToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status?: string;
}

/**
 * Wire up Copilot session events to Agor's streaming callbacks
 *
 * @param session - Copilot SDK session with event emitter
 * @param streamingCallbacks - Agor streaming callbacks for real-time UI updates
 * @param messageId - Message ID for the current streaming message
 * @param sessionId - Agor session ID
 * @param taskId - Optional Agor task ID
 * @returns Object with accumulated usage data and collected tool uses
 */
export function mapCopilotEvents(
  session: CopilotSessionEvents,
  streamingCallbacks: StreamingCallbacks | undefined,
  messageId: MessageID,
  sessionId: SessionID,
  taskId?: TaskID
): {
  usage: AccumulatedCopilotUsage;
  toolUses: CollectedToolUse[];
  getStreamStarted: () => boolean;
} {
  const usage: AccumulatedCopilotUsage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };

  const toolUses: CollectedToolUse[] = [];
  let streamStarted = false;

  // Text streaming — token-level chunks
  session.on('assistant.message_delta', (event) => {
    const chunk = event.data.deltaContent;
    if (!chunk) return;

    if (streamingCallbacks) {
      // Start stream on first chunk if not started
      if (!streamStarted) {
        streamingCallbacks
          .onStreamStart(messageId, {
            session_id: sessionId,
            task_id: taskId,
            role: MessageRole.ASSISTANT,
            timestamp: new Date().toISOString(),
          })
          .then(() => {
            streamStarted = true;
            return streamingCallbacks.onStreamChunk(messageId, chunk);
          })
          .catch((err) => {
            console.error(`[Copilot] Streaming start/chunk failed for ${messageId}:`, err);
          });
      } else {
        streamingCallbacks.onStreamChunk(messageId, chunk).catch((err) => {
          console.error(`[Copilot] Streaming chunk failed for ${messageId}:`, err);
        });
      }
    }
  });

  // Thinking/reasoning streaming
  session.on('assistant.reasoning_delta', (event) => {
    const chunk = event.data.deltaContent;
    if (!chunk) return;

    if (streamingCallbacks?.onThinkingChunk) {
      if (!streamStarted && streamingCallbacks.onThinkingStart) {
        streamingCallbacks
          .onThinkingStart(messageId, {})
          .then(() => streamingCallbacks.onThinkingChunk?.(messageId, chunk))
          .catch((err) => {
            console.error(`[Copilot] Thinking start/chunk failed for ${messageId}:`, err);
          });
      } else {
        streamingCallbacks.onThinkingChunk(messageId, chunk).catch((err) => {
          console.error(`[Copilot] Thinking chunk failed for ${messageId}:`, err);
        });
      }
    }
  });

  // Tool execution events — collect for message content
  session.on('tool.execution_start', (event) => {
    const data = event.data;
    const toolName = data.mcpServerName
      ? `${data.mcpServerName}.${data.mcpToolName || data.toolName}`
      : data.toolName;

    console.log(`🔧 [Copilot] Tool started: ${toolName} (${data.toolCallId})`);
  });

  session.on('tool.execution_complete', (event) => {
    const data = event.data;
    const toolName = data.mcpServerName
      ? `${data.mcpServerName}.${data.mcpToolName || data.toolName}`
      : data.toolName;

    toolUses.push({
      id: data.toolCallId,
      name: toolName,
      input: {}, // Copilot doesn't re-emit input on completion
      output: data.output,
      status: data.status,
    });

    console.log(`✅ [Copilot] Tool completed: ${toolName} (${data.status || 'success'})`);
  });

  // Usage tracking
  session.on('assistant.usage', (event) => {
    const data = event.data;
    usage.input_tokens = data.input_tokens ?? usage.input_tokens;
    usage.output_tokens = data.output_tokens ?? usage.output_tokens;
    usage.total_tokens = data.total_tokens ?? usage.input_tokens + usage.output_tokens;
    if (data.model) {
      usage.model = data.model;
    }
  });

  // Sub-agent events (unique to Copilot)
  session.on('subagent.started', (event) => {
    console.log(`🤖 [Copilot] Sub-agent started: ${event.data.agentName}`);
  });

  session.on('subagent.completed', (event) => {
    console.log(`✅ [Copilot] Sub-agent completed: ${event.data.agentName}`);
  });

  // Error handling
  session.on('session.error', (event) => {
    console.error(`❌ [Copilot] Session error:`, event.error);
    if (streamingCallbacks && streamStarted) {
      streamingCallbacks.onStreamError(messageId, event.error).catch(() => {
        /* best-effort */
      });
    }
  });

  return {
    usage,
    toolUses,
    getStreamStarted: () => streamStarted,
  };
}
