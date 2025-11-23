/**
 * @agor/core/sdk - Centralized AI SDK re-exports
 *
 * All AI SDK dependencies are managed in @agor/core to:
 * - Ensure version consistency across the monorepo
 * - Centralize peer dependency management (zod, OpenTelemetry, etc.)
 * - Enable re-use across packages (executor, daemon, CLI, UI)
 * - Simplify dependency management
 *
 * Usage:
 *   import { Claude } from '@agor/core/sdk';
 *   const { query } = Claude;
 *
 *   import { Codex } from '@agor/core/sdk';
 *   const codex = new Codex(...);
 */

// Claude Agent SDK - direct type exports for convenience
export type {
  PermissionMode,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from '@anthropic-ai/claude-agent-sdk';
// Claude Agent SDK - namespace export
export * as Claude from '@anthropic-ai/claude-agent-sdk';
// Gemini CLI SDK
export * as Gemini from '@google/gemini-cli-core';
// Google GenAI SDK
export * as GenAI from '@google/genai';
// Codex SDK - direct type exports for convenience
export type { Thread, ThreadItem } from '@openai/codex-sdk';
// Codex SDK - namespace export
export * as Codex from '@openai/codex-sdk';

// OpenCode SDK
export * as OpenCode from '@opencode-ai/sdk';
