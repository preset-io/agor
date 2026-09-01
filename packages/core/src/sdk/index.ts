/**
 * @agor/core/sdk - Type-only AI SDK compatibility exports
 *
 * Runtime SDK loading belongs exclusively to the managed integration loader.
 * Keeping this entrypoint type-only prevents importing an unselected package
 * merely because a shared executor or daemon module was loaded.
 */

// Claude Agent SDK - direct type exports for convenience
export type {
  PermissionMode,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
// Codex SDK - direct type exports for convenience
export type { CodexOptions, Thread, ThreadItem, TurnCompletedEvent } from '@openai/codex-sdk';
